const express = require('express');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');
// Import Firebase modules
const { db, admin, documentIdFromSeed, createRequiredIndexes, initializeCollections, COLLECTIONS } = require('./firebase');
const memories = require('./memories');

const uuid = require('uuid');

dotenv.config();

// Initialize Express app
const app = express();
app.use(express.json());

// Initialize Google Gemini AI
const genAI = new GoogleGenerativeAI("AIzaSyDTsIbCVC8JyIWzlZaa0gUDkMEafV6f1SY");
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'mentor.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Database schema constants
const DB_SCHEMAS = {
  USERS: 'users',
  TASKS: 'tasks',
  NUTRITION_LOGS: 'nutrition_logs',
  CONVERSATIONS: 'conversations',  // For storing conversations
  USER_CONTEXT: 'user_context',    // For storing user context
  USER_PREFERENCES: 'user_preferences',  // For storing personalized preferences
  HEALTH_LOGS: 'health_logs'       // For storing health data
};

// Add these constants at the top of your file
const SILENCE_THRESHOLD = 1.0; // 1 second gap between segments to consider it a silence
const MAX_SEGMENT_BUFFER_TIME = 5.0; // Maximum time to buffer segments before processing
const MIN_SEGMENT_LENGTH = 3; // Minimum number of words to consider processing

class MessageBuffer {
  constructor() {
    this.buffers = new Map();
    this.cleanupInterval = 300000; // 5 minutes
    this.lastCleanup = Date.now();
    this.MIN_WORDS_AFTER_SILENCE = 15;
    this.ANALYSIS_INTERVAL = 20000;
    this.QUESTION_AGGREGATION_TIME = 5000; // 5 seconds
    this.TRIGGER_PHRASES = ['hey omi', 'hey, omi'];
    this.PARTIAL_FIRST = ['hey', 'hey,'];
    this.PARTIAL_SECOND = ['omi'];
    this.NOTIFICATION_COOLDOWN = 10000; // 10 seconds
    this.notificationCooldowns = new Map();
    this.MEMORY_TTL = 86400000; // 24 hours for session memory
    this.CONTEXT_LIMIT = 10;    // Maximum number of context entries to keep
  }

  getBuffer(sessionId) {
    const currentTime = Date.now();

    if (currentTime - this.lastCleanup > this.cleanupInterval) {
      this.cleanupOldSessions();
    }

    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, {
        messages: [],
        triggerDetected: false,
        triggerTime: 0,
        collectedQuestion: [],
        responseSent: false,
        partialTrigger: false,
        partialTriggerTime: 0,
        lastActivity: currentTime,
        context: {
          user_name: "User",
          user_facts: [],
          user_context: [],
          previousAnalyses: [],
          silence_detected: false,
          words_after_silence: 0,
          last_analysis_time: Date.now()
        }
      });
    }

    const buffer = this.buffers.get(sessionId);
    buffer.lastActivity = currentTime;
    return buffer;
  }

  addConversationHistory(sessionId, entry) {
    const buffer = this.getBuffer(sessionId);
    buffer.context.conversation_history.push(entry);
    if (buffer.context.conversation_history.length > 10) {
      buffer.context.conversation_history.shift();
    }
  }

  updateCommunicationStyle(sessionId, style) {
    const buffer = this.getBuffer(sessionId);
    buffer.context.communication_style = style;
  }

  updateUserProfile(sessionId, updates) {
    const buffer = this.getBuffer(sessionId);
    buffer.context = { ...buffer.context, ...updates };
  }

  addUserContext(sessionId, context) {
    const buffer = this.getBuffer(sessionId);
    buffer.context.user_context.push(context);
    if (buffer.context.user_context.length > 5) {
      buffer.context.user_context.shift();
    }
  }

  getUserContext(sessionId) {
    const buffer = this.getBuffer(sessionId);
    return {
      user_name: buffer.context.user_name,
      user_facts: buffer.context.user_facts.join('. '),
      user_context: buffer.context.user_context.join('\n')
    };
  }

  cleanupOldSessions() {
    const currentTime = Date.now();
    for (const [sessionId, data] of this.buffers.entries()) {
      if (currentTime - data.lastActivity > 3600000) { // 1 hour
        this.buffers.delete(sessionId);
        this.notificationCooldowns.delete(sessionId);
      }
    }
    this.lastCleanup = currentTime;
  }

  async loadUserContext(sessionId) {
    try {
      // Load user context from Supabase
      const { data, error } = await supabase
        .from(DB_SCHEMAS.USER_CONTEXT)
        .select('*')
        .eq('user_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(this.CONTEXT_LIMIT);

      if (error) throw error;

      const buffer = this.getBuffer(sessionId);
      if (data && data.length > 0) {
        buffer.context.user_context = data.map(item => item.context_data);
        buffer.context.last_interaction = data[0].created_at;
      }

      return buffer.context;
    } catch (error) {
      logger.error('Error loading user context:', error);
      return this.getBuffer(sessionId).context;
    }
  }

  async saveUserContext(sessionId, contextData) {
    try {
      // Validate context data
      if (!contextData || typeof contextData !== 'string' || contextData.trim().length < 10) {
        logger.info('Skipping storage of invalid or small context data');
        return false;
      }

      const { error } = await supabase
        .from(DB_SCHEMAS.USER_CONTEXT)
        .insert({
          user_id: sessionId,
          context_data: contextData,
          context_type: 'interaction',
          created_at: new Date().toISOString()
        });

      if (error) throw error;

      // Update local buffer
      const buffer = this.getBuffer(sessionId);
      buffer.context.user_context.unshift(contextData);
      if (buffer.context.user_context.length > this.CONTEXT_LIMIT) {
        buffer.context.user_context.pop();
      }

      return true;
    } catch (error) {
      logger.error('Error saving user context:', error);
      return false;
    }
  }

  async storeConversation(sessionId, userText, response, category) {
    try {
      // Don't store conversations without meaningful content
      if (!userText || userText.trim().length < 5 || !response || response.trim().length < 5) {
        logger.info('Skipping storage of empty or very short conversation');
        return false;
      }

      // Store only if we have a valid user ID and category
      if (!sessionId || !category) {
        logger.warn('Missing sessionId or category for conversation storage');
        return false;
      }

      // Add a relevance score (simple implementation - can be enhanced)
      const relevanceScore = this.calculateRelevanceScore(userText, response, category);

      // Only store conversations with sufficient relevance
      if (relevanceScore < 0.3) {
        logger.info(`Skipping low relevance conversation (score: ${relevanceScore})`);
        return false;
      }

      const { error } = await supabase
        .from(DB_SCHEMAS.CONVERSATIONS)
        .insert({
          uid: sessionId,
          user_text: userText,
          response: response,
          category: category,
          relevance_score: relevanceScore,
          created_at: new Date().toISOString()
        });

      if (error) throw error;
      return true;
    } catch (error) {
      logger.error('Error storing conversation:', error);
      return false;
    }
  }

  calculateRelevanceScore(userText, response, category) {
    // Simple scoring logic - can be enhanced with ML later
    let score = 0.5; // Base score

    // Length-based scoring
    if (userText.length > 20) score += 0.1;
    if (response.length > 40) score += 0.1;

    // Category-based scoring
    if (category !== 'general') score += 0.2;

    // Look for question marks in user text (likely indicates a question)
    if (userText.includes('?')) score += 0.1;

    // Cap at 1.0
    return Math.min(score, 1.0);
  }
}

const messageBuffer = new MessageBuffer();

// Add this class to handle segment buffering
class SegmentBuffer {
  constructor() {
    this.segments = new Map(); // Map of user_id to their segment buffers
    this.lastProcessedTime = new Map(); // Track last processed time for each user
  }

  addSegment(userId, segment) {
    if (!this.segments.has(userId)) {
      this.segments.set(userId, []);
      this.lastProcessedTime.set(userId, Date.now());
    }

    const userSegments = this.segments.get(userId);
    userSegments.push(segment);

    // Sort segments by start time
    userSegments.sort((a, b) => a.start - b.start);
  }

  shouldProcess(userId, currentSegment) {
    const userSegments = this.segments.get(userId);
    if (!userSegments || userSegments.length === 0) return false;

    const lastSegment = userSegments[userSegments.length - 1];

    // Check for silence gap
    const silenceGap = currentSegment.start - lastSegment.end;
    if (silenceGap >= SILENCE_THRESHOLD) return true;

    // Check for maximum buffer time
    const bufferDuration = currentSegment.end - userSegments[0].start;
    if (bufferDuration >= MAX_SEGMENT_BUFFER_TIME) return true;

    // Check if we have a complete thought (ends with punctuation)
    const combinedText = this.getCombinedText(userId);
    if (combinedText.match(/[.!?]\s*$/)) return true;

    return false;
  }

  getCombinedText(userId) {
    const userSegments = this.segments.get(userId) || [];
    return userSegments
      .map(segment => segment.text.trim())
      .join(' ')
      .replace(/\s+/g, ' '); // Remove extra spaces
  }

  clearBuffer(userId) {
    this.segments.set(userId, []);
    this.lastProcessedTime.set(userId, Date.now());
  }
}

// Initialize the segment buffer
const segmentBuffer = new SegmentBuffer();

// Agents for different functionalities
const agents = {
  nutrition: {
    triggers: ['eat', 'food', 'meal', 'calories', 'diet', 'nutrition', 'snack', 'hungry'],
    prompt: (context, currentText) => `
      You are a nutrition assistant and personal mentor for ${context.user_name}. Analyze this message with military precision:

      PHASE 1 - SILENT ANALYSIS:
      1. Identify EXACT food items mentioned (name, quantity, meal type)
      2. Calculate macronutrients if possible (carbs: 45%, protein: 30%, fats: 25%)
      3. Cross-reference with ${context.user_name}'s goals: ${context.user_goals}
      4. Identify ONE key improvement opportunity

      ONLY proceed if ALL criteria met:
      - Clear food/meal identification
      - Direct nutrition relevance
      - Actionable advice exists

      PHASE 2 - RESPONSE:
      - Speak DIRECTLY to ${context.user_name}
      - Lead with EMPATHY: "I notice..." 
      - State ONE specific observation
      - Propose ONE concrete action
      - Ask ONE implementation question
      - MAX 280 characters
      - NO markdown

      Format response:
      {
        "analysis": {
          "mealType": "breakfast/lunch/dinner/snack",
          "items": [{
            "name": string,
            "quantity": string,
            "calories": number,
            "protein_g": number,
            "carbs_g": number,
            "fats_g": number
          }],
          "goalAlignment": "positive/neutral/negative",
          "primaryIssue": string
        },
        "response": string
      }
    `
  },
  productivity: {
    triggers: ['task', 'deadline', 'meeting', 'project', 'schedule', 'reminder'],
    prompt: (context, currentText) => `
      You are a productivity strategist for ${context.user_name}. Process this with military precision:

      PHASE 1 - SILENT ANALYSIS:
      1. Extract HARD deadlines (date+time)
      2. Identify task dependencies
      3. Cross-check with existing commitments
      4. Calculate time requirements
      5. Flag priority conflicts

      ONLY proceed if:
      - At least ONE concrete deadline/task
      - Clear ownership (who's responsible)
      - Actionable next step exists

      PHASE 2 - RESPONSE:
      - Speak DIRECTLY to ${context.user_name}
      - Use URGENCY SCALE: Low/Medium/High/Critical
      - Propose ONE scheduling action
      - Ask ONE commitment question
      - MAX 280 characters
      - NO markdown

      Format response:
      {
        "tasks": [{
          "title": string,
          "deadline": "YYYY-MM-DD HH:mm",
          "duration_min": number,
          "dependencies": string[],
          "priority": 1-4,
          "owner": string
        }],
        "conflicts": [{
          "task1": string,
          "task2": string,
          "resolution": string
        }],
        "response": string
      }
    `
  },
  conversation: {
    triggers: ['discuss', 'argue', 'disagree', 'opinion', 'feedback', 'talk'],
    prompt: (context, currentText) => `
      You are a conversation analyst and personal mentor for ${context.user_name}. Your task is to analyze the following text and provide actionable advice.
      
      STEP 1 - Evaluate SILENTLY:
      1. Is ${context.user_name} participating in a conversation or discussion?
      2. Are there specific topics, viewpoints, or communication challenges mentioned?
      3. Can you provide a STRONG, CLEAR recommendation to improve ${context.user_name}'s communication or understanding?
      
      If ALL conditions are met, proceed to STEP 2. Otherwise, respond with an empty string.
      
      STEP 2 - Provide feedback:
      - Speak DIRECTLY to ${context.user_name} - no third-person commentary.
      - Take a clear stance - no "however" or "on the other hand".
      - Keep it under 300 characters.
      - Use simple, everyday words like you're talking to a friend.
      - Reference specific details from what ${context.user_name} said.
      - Be bold and direct - ${context.user_name} needs clarity, not options.
      - End with a specific question about implementing your advice.
      
      What we know about ${context.user_name}: ${context.user_facts}
      
      Current discussion:
      ${currentText}
      
      Previous discussions and context: ${context.user_context}
      
      Return in JSON format:
      {
        "analysis": {
          "topics": string[],
          "suggestedQuestions": string[],
          "alternativeViewpoints": string[],
          "communicationFeedback": string
        },
        "response": string
      }
    `
  },
  health: {
    triggers: ['workout', 'exercise', 'fitness', 'gym', 'sleep', 'steps', 'active', 'heart rate', 'weight'],
    prompt: (context, currentText) => `
      You are a health and fitness expert for ${context.user_name}. Analyze this message:

      PHASE 1 - ANALYSIS:
      1. Identify exercise types, duration, intensity
      2. Extract sleep patterns if mentioned
      3. Note vital metrics (weight, heart rate, etc.)
      4. Compare with ${context.user_name}'s fitness goals

      ONLY proceed if:
      - Clear fitness/health data identified
      - Actionable advice possible
      - Data can be tracked

      PHASE 2 - RESPONSE:
      - Direct, personal tone to ${context.user_name}
      - ONE concrete insight
      - ONE specific recommendation
      - ONE tracking suggestion
      - MAX 300 characters
      - NO markdown

      Format response:
      {
        "analysis": {
          "activityType": string,
          "metrics": {
            "duration_min": number,
            "intensity": "low/medium/high",
            "calories_burned": number
          },
          "sleepData": {
            "hours": number,
            "quality": "poor/fair/good"
          },
          "insights": string[]
        },
        "response": string
      }
    `
  },
  learning: {
    triggers: ['learn', 'study', 'book', 'course', 'read', 'knowledge', 'skill', 'understand', 'remember'],
    prompt: (context, currentText) => `
      You are a learning coach for ${context.user_name}. Analyze this learning-related message:

      PHASE 1 - ANALYSIS:
      1. Identify learning topic/subject
      2. Determine ${context.user_name}'s knowledge level
      3. Recognize learning style preferences
      4. Identify obstacles to understanding

      ONLY proceed if:
      - Clear learning goal identified
      - Specific subject mentioned
      - Learning assistance is requested

      PHASE 2 - RESPONSE:
      - Encouraging but realistic tone
      - ONE learning strategy recommendation
      - ONE resource suggestion
      - ONE implementation question
      - MAX 300 characters
      - NO markdown

      Format response:
      {
        "analysis": {
          "subject": string,
          "knowledgeLevel": "beginner/intermediate/advanced",
          "learningStyle": "visual/auditory/reading/kinesthetic",
          "obstacles": string[],
          "recommendedApproach": string
        },
        "response": string
      }
    `
  },
  social: {
    triggers: ['relationship', 'friend', 'partner', 'family', 'colleague', 'team', 'communicate', 'conflict'],
    prompt: (context, currentText) => `
      You are a relationship advisor for ${context.user_name}. Analyze this social situation:

      PHASE 1 - ANALYSIS:
      1. Identify relationship type and dynamics
      2. Recognize communication patterns
      3. Detect potential conflicts or challenges
      4. Consider ${context.user_name}'s perspective

      ONLY proceed if:
      - Clear relationship context identified
      - Specific social situation described
      - Actionable advice possible

      PHASE 2 - RESPONSE:
      - Empathetic but direct tone
      - ONE communication insight
      - ONE concrete suggestion
      - MAX 300 characters
      - NO markdown

      Format response:
      {
        "analysis": {
          "relationshipType": string,
          "communicationStyle": string,
          "challengeIdentified": string,
          "emotionalImpact": string,
          "recommendedApproach": string
        },
        "response": string
      }
    `
  }
};

// Extract topics using Gemini
async function extractTopicsUsingGemini(text) {
  try {
    const prompt = `Analyze this text and identify the SINGLE most relevant category from: ${Object.keys(agents).join(', ')}.
    Text: ${text}
    Return ONLY a JSON string with a single category. Example: "nutrition" or "productivity".
    Consider these categories and their contexts:
    - nutrition: food, meals, diet, eating
    - productivity: tasks, scheduling, work, planning
    - conversation: general chat, discussions
    - health: exercise, wellness, fitness
    - learning: education, skills, understanding
    - social: relationships, interactions
    
    Choose the MOST dominant category. Do not return multiple categories.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Log the raw response for debugging
    logger.info('Topic extraction raw response:', responseText);

    // Remove any quotes from the response and ensure it's a valid category
    const category = responseText.replace(/["']/g, '').trim();

    // Validate that the category exists in our agents
    if (Object.keys(agents).includes(category)) {
      return category;
    }

    logger.warn('Invalid category returned:', category);
    return 'general';
  } catch (error) {
    logger.error('Topic extraction error:', error);
    return 'general';
  }
}

// Detect if the text contains an instruction
async function detectInstructionType(text, sessionId) {
  try {
    const topic = await extractTopicsUsingGemini(text);
    logger.info(`Detected primary topic: ${topic}`);

    if (topic === 'conversation') {
      const prompt = `Does this text require conversation analysis?
      Text: "${text}"
      Respond with JSON: { "needsAnalysis": boolean, "analysisType": "feedback"|"disagreement"|"clarification"|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.needsAnalysis) {
        return { type: 'conversation', analysisType: analysis.analysisType };
      }
    }

    // Check for productivity instructions
    if (topic === 'productivity') {
      const prompt = `Is this text an instruction or task? Examples: reminders, meetings, todos.
      Text: "${text}"
      Respond with JSON: { "isInstruction": boolean, "type": "reminder"|"meeting"|"task"|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.isInstruction) {
        return { type: 'productivity', instructionType: analysis.type };
      }
    }

    // Check for nutrition instructions
    if (topic === 'nutrition') {
      const prompt = `Does this text describe food consumption? 
      Text: "${text}"
      Respond with JSON: { "isMealReport": boolean, "mealType": string|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.isMealReport) {
        return { type: 'nutrition', mealType: analysis.mealType };
      }
    }

    // Health check
    if (topic === 'health') {
      const prompt = `Is this text related to health, fitness, or wellness activities?
      Text: "${text}"
      Respond with JSON: { "isHealthRelated": boolean, "activityType": "exercise"|"sleep"|"vitals"|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.isHealthRelated) {
        return { type: 'health', activityType: analysis.activityType };
      }
    }

    // Learning check
    if (topic === 'learning') {
      const prompt = `Is this text about learning or studying something?
      Text: "${text}"
      Respond with JSON: { "isLearningRelated": boolean, "subject": string|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.isLearningRelated) {
        return { type: 'learning', subject: analysis.subject };
      }
    }

    // Social check
    if (topic === 'social') {
      const prompt = `Is this text about relationships or social interactions?
      Text: "${text}"
      Respond with JSON: { "isSocialRelated": boolean, "relationshipType": string|null }`;

      const result = await model.generateContent(prompt);
      const analysis = JSON.parse(result.response.text());

      if (analysis.isSocialRelated) {
        return { type: 'social', relationshipType: analysis.relationshipType };
      }
    }

    // Return the detected topic as the type if no specific instruction was found
    return { type: topic };
  } catch (error) {
    logger.error('Instruction detection error:', error);
    return { type: 'general' };
  }
}

async function generateGeneralResponse(text, sessionId) {
  try {
    const context = messageBuffer.getUserContext(sessionId);
    const prompt = `As Omi, respond to: ${text}\n\nUser context: ${JSON.stringify(context)}`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    logger.error('General response error:', error);
    return "I'm having trouble processing that. Could you rephrase?";
  }
}

async function generateResponse(category, sessionId, currentText) {
  try {
    const agent = agents[category];
    const userContext = messageBuffer.getUserContext(sessionId);
    const prompt = agent.prompt(userContext, currentText);
    const result = await model.generateContent(prompt);
    const response = JSON.parse(result.response.text());

    // Log the generated response
    console.log('Generated response:', response);

    messageBuffer.addUserContext(sessionId, currentText);
    return response;
  } catch (error) {
    logger.error('Error generating response:', error);
    return { response: "I'm having trouble processing that. Could you rephrase?" };
  }
}

async function storeTasks(sessionId, tasks) {
  try {
    const tasksToInsert = tasks.map(task => ({
      user_id: sessionId,
      title: task.title,
      deadline: new Date(task.deadline).toISOString(),
      priority: task.priority,
      metadata: {
        duration_min: task.duration_min,
        dependencies: task.dependencies,
        owner: task.owner
      }
    }));

    const { data, error } = await supabase
      .from(DB_SCHEMAS.TASKS)
      .insert(tasksToInsert)
      .select();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Task storage error:', error);
    return null;
  }
}

async function storeNutritionLog(sessionId, analysis) {
  try {
    const totalCalories = analysis.items.reduce((sum, item) => sum + (item.calories || 0), 0);
    const totalProtein = analysis.items.reduce((sum, item) => sum + (item.protein_g || 0), 0);
    const totalCarbs = analysis.items.reduce((sum, item) => sum + (item.carbs_g || 0), 0);
    const totalFats = analysis.items.reduce((sum, item) => sum + (item.fats_g || 0), 0);

    const nutritionData = {
      user_id: sessionId,
      meal_type: analysis.mealType,
      foods: analysis.items,
      total_calories: totalCalories,
      total_protein: totalProtein,
      total_carbs: totalCarbs,
      total_fats: totalFats,
      meal_time: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from(DB_SCHEMAS.NUTRITION_LOGS)
      .insert(nutritionData)
      .select();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Nutrition log storage error:', error);
    return null;
  }
}

// New storage functions for additional agents
async function storeHealthActivity(sessionId, analysis) {
  try {
    const healthData = {
      user_id: sessionId,
      activity_type: analysis.activityType,
      duration: analysis.metrics?.duration_min || 0,
      intensity: analysis.metrics?.intensity || 'medium',
      calories_burned: analysis.metrics?.calories_burned || 0,
      sleep_hours: analysis.sleepData?.hours || 0,
      sleep_quality: analysis.sleepData?.quality || 'fair',
      recorded_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from(DB_SCHEMAS.HEALTH_LOGS)
      .insert(healthData)
      .select();

    if (error) throw error;
    return data;
  } catch (error) {
    logger.error('Health activity storage error:', error);
    return null;
  }
}

// Modify your webhook handler
app.post('/webhook', async (req, res) => {
  try {
    logger.info('Webhook request received');
    logger.debug('Request Body:', JSON.stringify(req.body, null, 2));
    logger.debug('Request Query Parameters:', req.query);

    // Extract the user ID from query parameters (primary) or body (fallback)
    const uid = req.query.uid || req.body.session_id || req.body.uid;

    if (!uid) {
      logger.warn('No user identification provided in query parameters or request body');
      return res.status(400).json({
        success: false,
        message: 'No user identification provided. Please include uid as a query parameter.'
      });
    }

    // Rate limiting check
    const currentTime = Date.now();
    const cooldownTime = messageBuffer.notificationCooldowns.get(uid) || 0;
    if (currentTime - cooldownTime < 1000) { // 1 second cooldown
      logger.warn('Too many requests from user:', uid);
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again shortly.'
      });
    }

    // Determine the type of payload (memory object or real-time transcript)
    const isMemory = req.body.id !== undefined &&
      req.body.transcript_segments !== undefined;

    logger.info(`Processing ${isMemory ? 'memory object' : 'real-time transcript'} for user: ${uid}`);

    if (isMemory) {
      // Process memory object - this will store it in Firestore under the user's collection
      return await processMemoryObject(req.body, uid, res);
    } else {
      // Process real-time transcript
      return await processRealTimeTranscript(req.body, uid, res);
    }
  } catch (error) {
    logger.error('Webhook processing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// New function to process memory objects
async function processMemoryObject(memory, uid, res) {
  try {
    logger.info(`Processing memory object ID: ${memory.id} for user: ${uid}`);

    // SIMPLIFIED MEMORY STORAGE - Focus on storing memory in Firestore with UID
    try {
      // Check if we have a valid memory ID
      if (!memory.id) {
        memory.id = uuid.v4(); // Generate ID if none exists
        logger.info(`Generated new memory ID: ${memory.id} for user ${uid}`);
      }

      // Ensure memory has appropriate timestamps
      if (!memory.created_at) {
        memory.created_at = new Date();
      }

      // Ensure memory has proper status
      if (!memory.status) {
        memory.status = memories.MEMORY_STATUS.IN_PROGRESS;
      }

      // Ensure other required fields
      memory.deleted = memory.deleted || false;
      memory.discarded = memory.discarded || false;
      memory.type = memory.type || 'webhook';
      memory.source = memory.source || 'external';

      // Store the complete memory object in Firestore
      logger.info(`Storing memory ${memory.id} in Firestore for user ${uid}`);
      await memories.upsertMemory(uid, memory);

      // Extract action items if they exist
      const actionItems = memory.structured?.action_items || [];
      if (actionItems.length > 0) {
        await memories.updateMemoryActionItems(uid, memory.id, actionItems);
        logger.info(`Stored ${actionItems.length} action items for memory ${memory.id}`);
      }

      // Mark memory as completed
      await memories.updateMemoryStatus(uid, memory.id, memories.MEMORY_STATUS.COMPLETED);
      logger.info(`Memory ${memory.id} marked as completed for user ${uid}`);
    } catch (firestoreError) {
      logger.error(`Firestore storage error for memory ${memory.id}:`, firestoreError);
      // Continue processing even if Firestore storage fails
    }

    // Extract segments from the memory object
    const segments = memory.transcript_segments || [];

    if (segments.length === 0) {
      logger.warn('No transcript segments in memory object');
      return res.status(400).json({ message: 'No transcript segments provided' });
    }

    // Extract structured data
    const structuredData = memory.structured || {};
    const title = structuredData.title || 'Untitled Memory';
    const overview = structuredData.overview || '';
    const category = structuredData.category || 'general';
    const actionItems = structuredData.action_items || [];

    logger.info(`Memory title: ${title}, category: ${category}`);

    // Combine all transcript segments into a single text for analysis
    const combinedText = segments
      .map(segment => segment.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ');

    // Process the combined text
    const instructionAnalysis = await detectInstructionType(combinedText, uid);
    let detectedCategory = instructionAnalysis.type;

    // We can override with the memory's category if it maps to one of our agent categories
    if (category === 'food' || category === 'meals' || category === 'cooking') {
      detectedCategory = 'nutrition';
    } else if (category === 'work' || category === 'tasks' || category === 'meetings') {
      detectedCategory = 'productivity';
    } else if (category === 'fitness' || category === 'exercise' || category === 'workout') {
      detectedCategory = 'health';
    } else if (category === 'education' || category === 'study') {
      detectedCategory = 'learning';
    } else if (category === 'personal' || category === 'family' || category === 'friends') {
      detectedCategory = 'social';
    }

    let response;
    let storedData = null;

    // Generate a response based on the category
    if (Object.keys(agents).includes(detectedCategory)) {
      const agentResponse = await generateResponse(detectedCategory, uid, combinedText);
      response = agentResponse.response;

      // Store category-specific data
      if (detectedCategory === 'nutrition' && agentResponse.analysis) {
        storedData = await storeNutritionLog(uid, agentResponse.analysis);
      } else if (detectedCategory === 'productivity' && agentResponse.tasks?.length) {
        storedData = await storeTasks(uid, agentResponse.tasks);
      } else if (detectedCategory === 'health' && agentResponse.analysis) {
        storedData = await storeHealthActivity(uid, agentResponse.analysis);
      }
    } else {
      // Fall back to general
      detectedCategory = 'general';
      response = await generateGeneralResponse(combinedText, uid);
    }

    // Store conversation and update context
    try {
      await messageBuffer.storeConversation(uid, combinedText, response, detectedCategory);
      await messageBuffer.saveUserContext(uid, combinedText);
      logger.info(`Memory processed and stored for user: ${uid}`);
    } catch (error) {
      logger.error('Error storing conversation or context:', error);
    }

    return res.status(200).json({
      message: response,
      category: detectedCategory,
      data: storedData,
      memory_id: memory.id,
      user_id: uid,
      processed_text: combinedText,
      storage_status: 'success'
    });
  } catch (error) {
    logger.error('Memory processing error:', error);
    return res.status(500).json({ message: 'Error processing memory' });
  }
}

// Function to process real-time transcript
async function processRealTimeTranscript(data, uid, res) {
  try {
    // Extract segments from the request body
    const segments = data.segments || [];

    if (segments.length === 0) {
      logger.warn('No segments provided in the real-time transcript');
      return res.status(400).json({ message: 'No segments provided' });
    }

    let hasProcessed = false;
    let response = null;

    // Process each segment
    for (const segment of segments) {
      if (!segment.text?.trim()) continue;

      // Add segment to buffer
      segmentBuffer.addSegment(uid, segment);

      // Check if we should process the buffered segments
      if (segmentBuffer.shouldProcess(uid, segment)) {
        const combinedText = segmentBuffer.getCombinedText(uid);
        logger.info(`Processing combined segments for user ${uid}:`, combinedText);

        // Only process if the combined text is meaningful
        if (combinedText.split(' ').length >= MIN_SEGMENT_LENGTH) {
          // Check for trigger phrases
          const triggerPhrase = messageBuffer.TRIGGER_PHRASES.find(phrase =>
            combinedText.toLowerCase().includes(phrase.toLowerCase())
          );

          let questionPart = combinedText;
          if (triggerPhrase) {
            questionPart = combinedText.toLowerCase()
              .split(triggerPhrase)[1]
              ?.trim() || combinedText;
          }

          // Process the combined text
          const instructionAnalysis = await detectInstructionType(questionPart, uid);
          let category = instructionAnalysis.type;
          let storedData = null;

          switch (category) {
            case 'nutrition':
              const nutritionResponse = await generateResponse('nutrition', uid, questionPart);
              response = nutritionResponse.response;
              if (nutritionResponse.analysis) {
                storedData = await storeNutritionLog(uid, nutritionResponse.analysis);
              }
              break;

            case 'productivity':
              const productivityResponse = await generateResponse('productivity', uid, questionPart);
              response = productivityResponse.response;
              if (productivityResponse.tasks?.length) {
                storedData = await storeTasks(uid, productivityResponse.tasks);
              }
              break;

            case 'conversation':
              const conversationResponse = await generateResponse('conversation', uid, questionPart);
              response = conversationResponse.response;
              logger.info('Conversation response generated:', response);
              // Store conversation analysis in buffer context
              messageBuffer.addConversationHistory(uid, {
                analysis: conversationResponse.analysis,
                timestamp: new Date().toISOString()
              });
              break;

            case 'health':
              const healthResponse = await generateResponse('health', uid, questionPart);
              response = healthResponse.response;
              if (healthResponse.analysis) {
                storedData = await storeHealthActivity(uid, healthResponse.analysis);
              }
              break;

            case 'learning':
            case 'social':
              // For these categories, handle without specific storage
              const categoryResponse = await generateResponse(category, uid, questionPart);
              response = categoryResponse.response;
              logger.info(`${category} response generated:`, response);
              break;

            default:
              // If instructionAnalysis didn't determine a specific type, get the topic
              if (category === 'general' || !category) {
                category = await extractTopicsUsingGemini(questionPart);
                logger.info(`Topic extracted: ${category}`);
              }

              // If the category is a valid agent type
              if (Object.keys(agents).includes(category)) {
                const responseResult = await generateResponse(category, uid, questionPart);
                response = responseResult.response;
                logger.info(`${category} response generated:`, response);
                storedData = responseResult.data;
              } else {
                // Fallback to general
                category = 'general';
                response = await generateGeneralResponse(questionPart, uid);
                logger.info('General response generated:', response);
              }
          }

          // Store conversation and update context
          try {
            await messageBuffer.storeConversation(uid, questionPart, response, category);
            await messageBuffer.saveUserContext(uid, questionPart);
          } catch (error) {
            logger.error('Error storing conversation or context:', error);
          }

          hasProcessed = true;
          segmentBuffer.clearBuffer(uid);
          messageBuffer.notificationCooldowns.set(uid, currentTime);

          // Send response only if we have processed something meaningful
          if (response) {
            return res.status(200).json({
              message: response,
              category: category,
              data: storedData,
              user_id: uid,
              processed_text: combinedText,
              is_realtime: true
            });
          }
        }
      }
    }

    // If we haven't processed anything yet, return a waiting response
    if (!hasProcessed) {
      return res.status(202).json({
        message: 'Collecting more context...',
        buffered_text: segmentBuffer.getCombinedText(uid)
      });
    }
  } catch (error) {
    logger.error('Real-time transcript processing error:', error);
    return res.status(500).json({ message: 'Error processing real-time transcript' });
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  logger.info('Health check endpoint accessed');
  res.status(200).json({ status: 'ok', version: '1.0.0' });
});

// Add a simple endpoint to retrieve memories for a user
app.get('/memories/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const includeDiscarded = req.query.includeDiscarded === 'true';

    logger.info(`Retrieving memories for user ${userId}, limit: ${limit}, offset: ${offset}`);

    const userMemories = await memories.getMemories(userId, limit, offset, includeDiscarded);

    return res.status(200).json({
      success: true,
      user_id: userId,
      memories: userMemories,
      count: userMemories.length
    });
  } catch (error) {
    logger.error(`Error retrieving memories for user ${req.params.userId}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving memories',
      error: error.message
    });
  }
});

// Add endpoint to get a specific memory
app.get('/memory/:userId/:memoryId', async (req, res) => {
  try {
    const { userId, memoryId } = req.params;

    logger.info(`Retrieving memory ${memoryId} for user ${userId}`);

    const memory = await memories.getMemory(userId, memoryId);

    if (!memory) {
      return res.status(404).json({
        success: false,
        message: `Memory ${memoryId} not found for user ${userId}`
      });
    }

    return res.status(200).json({
      success: true,
      user_id: userId,
      memory_id: memoryId,
      memory
    });
  } catch (error) {
    logger.error(`Error retrieving memory ${req.params.memoryId} for user ${req.params.userId}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving memory',
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  logger.info(`AI Mentor running on port ${PORT}`);
});