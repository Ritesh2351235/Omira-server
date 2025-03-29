const express = require('express');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const winston = require('winston');
// Import Firebase modules
const { db, admin, documentIdFromSeed, createRequiredIndexes, initializeCollections, COLLECTIONS } = require('./firebase');
const memories = require('./memories');
const ApiQueue = require('./apiQueue');

const uuid = require('uuid');

dotenv.config();

// Initialize Express app
const app = express();
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // Add your API key to .env file
});

// Initialize API Queue for OpenAI requests
const openaiQueue = new ApiQueue({
  maxConcurrent: 50, // Limit concurrent requests
  maxRetries: 3,     // Retry rate limit errors up to 3 times
  baseDelay: 2000,   // Start with 2s delay (then 4s, 8s for exponential backoff)
  logger: logger     // Use the same logger as the rest of the app
});

// OpenAI model configurations
const MODELS = {
  REASONING: 'gpt-4',  // Changed from gpt-4-turbo-preview to gpt-4
  CONVERSATION: 'gpt-4', // Changed from gpt-4-turbo-preview to gpt-4
  QUICK: 'gpt-4'  // Changed from gpt-3.5-turbo to gpt-4
};

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
    this.TRIGGER_PHRASES = ['hey omira', 'hey, omira'];
    this.PARTIAL_FIRST = ['hey', 'hey,'];
    this.PARTIAL_SECOND = ['omira'];
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
          last_analysis_time: Date.now(),
          conversation_history: [] // Add this to store conversation history
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

// Enhanced agents for conversation and nutrition
const agents = {
  conversation: {
    triggers: ['discuss', 'argue', 'disagree', 'opinion', 'feedback', 'talk', 'meeting', 'chat', 'said', 'told'],
    prompt: (context, currentText) => `
      You are an empathetic conversation analyst for ${context.user_name}. Your task is to analyze this conversation and provide helpful insights.
      
      ANALYSIS STEPS:
      1. Identify the conversation type: argument, discussion, presentation, small talk, etc.
      2. Determine the emotional tone: Was ${context.user_name} calm, angry, defensive, assertive, etc.?
      3. Identify potential miscommunications or points where ${context.user_name} could have expressed themselves better.
      4. Consider alternative approaches that could have led to a better outcome.
      5. Analyze if ${context.user_name} was listening effectively or missing important points.
      
      RESPONSE FORMAT: Provide your analysis in this JSON structure:
      {
        "analysis": {
          "conversationType": "argument|discussion|presentation|meeting|casual|other",
          "emotionalTone": "calm|angry|defensive|assertive|passive|neutral",
          "keyPoints": ["point 1", "point 2"],
          "improvement_areas": ["area 1", "area 2"],
          "alternative_approaches": ["approach 1", "approach 2"],
          "effectiveness": 1-10 scale (10 being ideal communication),
          "was_listening": boolean
        },
        "dashboard_summary": "A 2-3 sentence summary of the conversation analysis for the dashboard",
        "detailed_feedback": "Constructive feedback (150-250 words) about how ${context.user_name} could improve their communication in similar situations",
        "alternative_responses": ["specific phrase that could have been said differently", "another alternative phrase"]
      }

      CONTEXT: ${currentText}
    `
  },
  nutrition: {
    triggers: ['eat', 'food', 'meal', 'calories', 'diet', 'nutrition', 'snack', 'hungry', 'breakfast', 'lunch', 'dinner', 'ate'],
    prompt: (context, currentText) => `
      You are a nutrition analyst. Analyze this text about food consumption:

      STEPS:
      1. Identify all food and drink items mentioned
      2. Estimate portion sizes where possible
      3. Calculate approximate macronutrients (proteins, carbs, fats)
      4. Estimate total calories
      5. Identify the meal type (breakfast, lunch, dinner, snack)
      6. Assess nutritional quality (balanced, protein-heavy, carb-heavy, etc.)
      7. Suggest one improvement if applicable

      RESPONSE FORMAT: Provide your analysis in this JSON structure:
      {
        "analysis": {
          "mealType": "breakfast|lunch|dinner|snack",
          "timeOfDay": "morning|afternoon|evening|night",
          "items": [
            {
              "name": "food name",
              "estimatedPortion": "portion in grams or standard serving",
              "calories": number,
              "protein_g": number,
              "carbs_g": number,
              "fats_g": number,
              "quality": "healthy|neutral|unhealthy"
            }
          ],
          "totalCalories": number,
          "macroBreakdown": {
            "protein_pct": number,
            "carbs_pct": number,
            "fats_pct": number
          },
          "nutritionalQuality": "excellent|good|average|poor",
          "balanced": boolean
        },
        "dashboard_summary": "A concise summary of the meal for the dashboard",
        "nutrition_feedback": "Brief feedback about the nutritional quality and one suggestion for improvement",
        "macros_visual_data": {
          "protein": number (percentage),
          "carbs": number (percentage),
          "fats": number (percentage)
        }
      }

      TEXT: ${currentText}
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

// Modified function to use the queue
async function generateStructuredResponse(prompt, model = MODELS.REASONING) {
  try {
    // Queue the API call
    const response = await openaiQueue.enqueue(
      // Function that returns the API call promise
      () => openai.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'system',
            content: 'You are an AI assistant that ALWAYS responds in valid JSON format. Your response should be a raw JSON object without any markdown formatting, explanation text, or code blocks. Do not include any text outside the JSON structure.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      }),
      `generateStructuredResponse (${model})`
    );

    const content = response.choices[0].message.content.trim();

    // Clean up the response if it contains markdown or extra text
    let jsonStr = content;
    if (content.includes('```')) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        jsonStr = match[1].trim();
      }
    }

    // Additional cleanup to ensure we have valid JSON
    jsonStr = jsonStr.replace(/^[^{]*/, '').replace(/[^}]*$/, '');

    console.log('Attempting to parse JSON response:', jsonStr);
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('OpenAI structured response error:', error);
    // Return a default empty response instead of throwing
    return {
      error: true,
      message: error.message,
      analysis: {
        error: true,
        message: "Failed to generate structured response"
      }
    };
  }
}

async function generateConversationReflection(text, context = {}) {
  try {
    const prompt = `Imagine you're the user's best friend giving them casual feedback about a conversation they just had. React like you're texting them or chatting over coffee - be genuine, personal, and conversational.

  Read this conversation they just had: "${text}"

  Now respond as their supportive friend would, following these guidelines:
  - Use casual language, contractions, and occasional slang (nothing offensive)
  - Address them directly with "you" (never use terms like "the speaker" or "the user")
  - Include specific details from their conversation to make it personal
  - Be honest but kind - like a real friend would be
  - Offer observations that feel insightful but not overly analytical
  - If you spot social cues they missed or opportunities they didn't take, mention them naturally
  - Include a bit of humor or personality where appropriate

  Format your response as JSON with these keys:
  {
    "hey": "A casual, specific greeting referencing something from their conversation",
    "nice_job": "Something genuine they did well in the conversation (be specific)",
    "between_us": "One gentle suggestion about what might have worked better, phrased like a friend would say it",
    "did_you_catch_that": "Something they might have missed (opportunity, hint, social cue) if applicable",
    "real_talk": "A brief, encouraging wrap-up that sounds like it's coming from a real friend"
  }

  Make it sound like a real person talking to their friend - not an analysis, report, or professional feedback.`;

    // Queue the API call
    const result = await openaiQueue.enqueue(
      // Function that returns the API call promise
      () => openai.chat.completions.create({
        model: MODELS.REASONING,
        messages: [
          {
            role: 'system',
            content: 'You are a close friend giving casual, genuine feedback. Use natural, conversational language. Be supportive but real - like a friend chatting over coffee.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.9, // Increased for more natural variation
        max_tokens: 1000,
        presence_penalty: 0.6, // Added to encourage more unique responses
        frequency_penalty: 0.6 // Added to discourage repetitive language
      }),
      `generateConversationReflection (${MODELS.REASONING})`
    );

    let reflection = JSON.parse(result.choices[0].message.content);
    return reflection;
  } catch (error) {
    logger.error('Error generating conversation reflection:', error);
    return null;
  }
}

// Function to store conversation reflection
async function storeConversationReflection(uid, memoryId, reflection, timestamp) {
  try {
    const reflectionDoc = {
      memory_id: memoryId,
      user_id: uid,
      created_at: timestamp || admin.firestore.FieldValue.serverTimestamp(),
      hey: reflection.hey,
      nice_job: reflection.nice_job,
      between_us: reflection.between_us,
      did_you_catch_that: reflection.did_you_catch_that,
      real_talk: reflection.real_talk
    };

    await db.collection('users')
      .doc(uid)
      .collection(COLLECTIONS.CONVERSATION_REFLECTIONS)
      .doc(memoryId)
      .set(reflectionDoc);

    return reflectionDoc;
  } catch (error) {
    logger.error('Error storing conversation reflection:', error);
    return null;
  }
}

// Function to process memory objects
async function processMemoryObject(memory, uid, res) {
  try {
    if (!memory.id || typeof memory.id !== 'string' || memory.id.trim() === '') {
      memory.id = uuid.v4();
    }

    const parseDate = (dateString) => {
      if (!dateString) return null;
      try {
        return new Date(dateString);
      } catch {
        return null;
      }
    };

    const memoryData = {
      ...memory,
      status: memories.MEMORY_STATUS.IN_PROGRESS,
      deleted: memory.deleted || false,
      discarded: memory.discarded || false,
      type: memory.type || 'webhook',
      source: memory.source || 'external',
      language: memory.language || 'en',
      visibility: memory.visibility || 'private',
      plugins_results: memory.plugins_results || [],
      metadata: memory.metadata || [],
      structured: memory.structured || {
        overview: '',
        action_items: [],
        category: 'general',
        title: 'Untitled Memory'
      },
      // Convert string dates to Date objects
      created_at: parseDate(memory.created_at),
      started_at: parseDate(memory.started_at),
      finished_at: parseDate(memory.finished_at),
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    };

    // First upsert of the memory with IN_PROGRESS status
    await memories.upsertMemory(uid, memoryData);

    const segments = memory.transcript_segments || [];
    if (segments.length === 0) {
      return res.status(400).json({ message: 'No transcript segments provided' });
    }

    // Combine segments into text
    const combinedText = segments
      .map(segment => segment.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ');

    // Check content types
    const contentTypesPrompt = `Analyze this text and determine if it contains nutrition information and/or conversation content:
    "${combinedText}"
    
    Return a JSON object with these exact fields:
    {
      "hasNutrition": boolean (true if contains food, meals, calories, or nutrition info),
      "hasConversation": boolean (true if contains meaningful dialogue, discussion, or interaction)
    }`;

    const contentTypesResponse = await generateStructuredResponse(contentTypesPrompt);
    const contentTypes = contentTypesResponse || { hasNutrition: false, hasConversation: false };

    // Process nutrition content if present
    if (contentTypes.hasNutrition) {
      try {
        const nutritionPrompt = `
        Analyze this text for nutrition information:
        "${combinedText}"
        
        Return a flat JSON structure with these exact fields:
        {
          "mealType": "breakfast|lunch|dinner|snack",
          "timeOfDay": "morning|afternoon|evening|night",
          "foods": [
            {
              "name": "food name",
              "estimatedPortion": "portion size",
              "calories": number,
              "protein_g": number,
              "carbs_g": number,
              "fats_g": number,
              "quality": "good|neutral|poor"
            }
          ],
          "total_calories": number,
          "macro_breakdown": {
            "protein_pct": number,
            "carbs_pct": number,
            "fats_pct": number
          },
          "quality_assessment": "excellent|good|average|poor",
          "is_balanced": boolean,
          "dashboard_summary": "2-3 sentence summary",
          "feedback": "single piece of constructive feedback",
          "visual_data": {
            "protein": number,
            "carbs": number,
            "fats": number
          }
        }`;

        const nutritionResponse = await generateStructuredResponse(nutritionPrompt);
        console.log('Nutrition analysis:', nutritionResponse);

        if (nutritionResponse && !nutritionResponse.error) {
          const nutritionMetadata = {
            analysis_type: 'nutrition',
            nutrition_data: {
              memory_id: memory.id,
              user_id: uid,
              meal_type: nutritionResponse.mealType,
              time_of_day: nutritionResponse.timeOfDay,
              foods: nutritionResponse.foods,
              total_calories: nutritionResponse.total_calories,
              macro_breakdown: nutritionResponse.macro_breakdown,
              quality_assessment: nutritionResponse.quality_assessment,
              is_balanced: nutritionResponse.is_balanced,
              dashboard_summary: nutritionResponse.dashboard_summary,
              feedback: nutritionResponse.feedback,
              recorded_at: parseDate(memory.created_at),
              visual_data: nutritionResponse.visual_data
            }
          };
          await memories.updateMemoryMetadata(uid, memory.id, nutritionMetadata);
        }
      } catch (error) {
        console.error('Nutrition analysis error:', error);
      }
    }

    // Process conversation content if present
    if (contentTypes.hasConversation) {
      try {
        const conversationPrompt = `
        Analyze this conversation:
        "${combinedText}"
        
        Return a flat JSON structure with these exact fields:
        {
          "conversationType": "argument|discussion|meeting|casual",
          "emotionalTone": "calm|angry|defensive|assertive|passive",
          "keyPoints": "comma separated list of main points",
          "improvementAreas": "comma separated list of areas to improve",
          "effectiveness": number (1-10),
          "wasListening": boolean,
          "dashboard_summary": "2-3 sentence summary",
          "feedback": "single piece of constructive feedback"
        }`;

        const conversationResponse = await generateStructuredResponse(conversationPrompt);
        console.log('Conversation analysis:', conversationResponse);

        if (conversationResponse && !conversationResponse.error) {
          const conversationMetadata = {
            analysis_type: 'conversation',
            conversation_data: {
              memory_id: memory.id,
              user_id: uid,
              conversation_type: conversationResponse.conversationType,
              emotional_tone: conversationResponse.emotionalTone,
              key_points: conversationResponse.keyPoints.split(',').map(p => p.trim()),
              improvement_areas: conversationResponse.improvementAreas.split(',').map(a => a.trim()),
              effectiveness: conversationResponse.effectiveness,
              was_listening: conversationResponse.wasListening,
              dashboard_summary: conversationResponse.dashboard_summary,
              feedback: conversationResponse.feedback,
              recorded_at: parseDate(memory.created_at)
            }
          };
          await memories.updateMemoryMetadata(uid, memory.id, conversationMetadata);
        }
      } catch (error) {
        console.error('Conversation analysis error:', error);
      }
    }

    // Generate and store conversation reflection
    const reflection = await generateConversationReflection(combinedText);
    if (reflection) {
      await storeConversationReflection(uid, memory.id, reflection, memory.created_at);

      // Add reflection to memory metadata
      const reflectionMetadata = {
        analysis_type: 'conversation_reflection',
        reflection_data: reflection
      };
      await memories.updateMemoryMetadata(uid, memory.id, reflectionMetadata);
    }

    // Final update - use a minimal object with just the necessary fields
    const completedMemory = {
      id: memory.id,
      status: memories.MEMORY_STATUS.COMPLETED,
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    };

    // Use merge option to update only these fields
    await memories.upsertMemory(uid, completedMemory, { merge: true });

    return res.status(200).json({
      success: true,
      user_id: uid,
      memory_id: memory.id,
      status: 'completed',
      reflection: reflection
    });

  } catch (error) {
    console.error('Memory processing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error processing memory',
      error: error.message
    });
  }
}

async function processRealTimeTranscript(data, uid, res) {
  try {
    console.log('Received data:', JSON.stringify(data));

    // Extract segments from the data structure
    let segments = [];
    if (data.segments) {
      segments = data.segments;
    } else if (Array.isArray(data)) {
      segments = data;
    } else if (typeof data === 'object') {
      segments = [data];
    }

    if (!segments || segments.length === 0) {
      console.warn('No segments provided in the real-time transcript');
      return res.status(400).json({ message: 'No segments provided' });
    }

    // Get the buffer for this user
    const buffer = messageBuffer.getBuffer(uid);
    const currentTime = Date.now();

    // Process each segment
    for (const segment of segments) {
      // Safely extract text from segment
      let text = '';
      if (typeof segment === 'string') {
        text = segment;
      } else if (segment.text) {
        text = segment.text;
      } else if (segment.transcript) {
        text = segment.transcript;
      }

      text = text.toString().toLowerCase().trim();
      if (!text) continue;

      console.log(`Processing text segment for user ${uid}: '${text}'`);

      // Check for trigger phrase
      const hasTrigger = text.includes('hey omi') || text.includes('hey, omi') || text.includes('hey,omi');

      if (hasTrigger && !buffer.triggerDetected) {
        console.log(`Trigger phrase detected for user ${uid}`);
        buffer.triggerDetected = true;
        buffer.triggerTime = currentTime;
        buffer.collectedQuestion = [];
        buffer.responseSent = false;

        // Create a new memory object for Firebase
        const memoryId = uuid.v4();
        const memoryObject = {
          id: memoryId,
          user_id: uid,
          created_at: new Date().toISOString(),
          transcript_segments: [{ text, timestamp: new Date().toISOString() }],
          status: memories.MEMORY_STATUS.IN_PROGRESS,
          type: 'realtime',
          source: 'voice',
          metadata: {
            trigger_detected: true,
            trigger_time: currentTime
          }
        };

        // Store in Firebase
        console.log(`Storing memory ${memoryId} in Firebase for user ${uid}`);
        await memories.upsertMemory(uid, memoryObject);
        console.log(`Successfully stored memory ${memoryId} in Firebase`);

        // Extract question part after trigger
        const questionPart = text.split(/hey,?\s*omi\s*[.,]?\s*/i)[1]?.trim();
        if (questionPart) {
          buffer.collectedQuestion.push(questionPart);
          console.log(`Initial question part: ${questionPart}`);
        }
      } else if (buffer.triggerDetected && !buffer.responseSent) {
        // Update memory with additional segments
        const existingMemory = await memories.getMemories(uid, 1, 0, false);
        if (existingMemory && existingMemory.length > 0) {
          const memory = existingMemory[0];
          memory.transcript_segments.push({
            text,
            timestamp: new Date().toISOString()
          });
          console.log(`Updating memory ${memory.id} with new segment`);
          await memories.upsertMemory(uid, memory);
          console.log(`Successfully updated memory ${memory.id}`);
        }

        // Collect additional parts of the question
        buffer.collectedQuestion.push(text);
        console.log(`Added to question: ${text}`);
      }

      // Check if we should process the collected question
      if (buffer.triggerDetected && !buffer.responseSent && buffer.collectedQuestion.length > 0) {
        const timeSinceTrigger = currentTime - buffer.triggerTime;
        const shouldProcess = timeSinceTrigger > 5000 || text.includes('?');

        if (shouldProcess) {
          const fullQuestion = buffer.collectedQuestion.join(' ').trim();
          console.log(`Processing complete question for user ${uid}: ${fullQuestion}`);

          try {
            // Get recent memories for context
            const recentMemories = await memories.getMemories(uid, 3, 0, false);
            console.log(`Retrieved ${recentMemories.length} recent memories for context`);

            const memoryContext = recentMemories.map(memory => {
              const segments = memory.transcript_segments || [];
              return segments.map(s => s.text || '').join(' ');
            }).join('\n\n');

            // Generate response using question and memory context
            console.log('Generating response using GPT-4');
            const prompt = `
              You are Omi, a helpful AI assistant. Answer this question using the context provided:

              Question: ${fullQuestion}

              Recent conversation context:
              ${memoryContext}

              Provide a clear, concise response (max 2-3 sentences). If the context isn't relevant, 
              just answer based on your knowledge.
            `;

            const result = await openaiQueue.enqueue(
              () => openai.chat.completions.create({
                model: MODELS.REASONING,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7,
                max_tokens: 1000,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0
              }),
              `generateResponse (${MODELS.REASONING})`
            );
            const response = result.choices[0].message.content.trim();
            console.log(`Generated response: ${response}`);

            // Update memory with response
            const existingMemory = await memories.getMemories(uid, 1, 0, false);
            if (existingMemory && existingMemory.length > 0) {
              const memory = existingMemory[0];
              memory.response = response;
              memory.status = memories.MEMORY_STATUS.COMPLETED;
              console.log(`Updating memory ${memory.id} with response`);
              await memories.upsertMemory(uid, memory);
              console.log(`Successfully updated memory ${memory.id} with response`);
            }

            // Reset buffer states
            buffer.triggerDetected = false;
            buffer.triggerTime = 0;
            buffer.collectedQuestion = [];
            buffer.responseSent = true;

            // Store the interaction
            await messageBuffer.storeConversation(uid, fullQuestion, response, 'general');
            console.log('Conversation stored successfully');

            console.log(`Sending response for user ${uid}: ${response}`);
            return res.status(200).json({
              success: true,
              message: response,
              user_id: uid,
              question: fullQuestion
            });
          } catch (error) {
            console.error('Error processing question:', error);
            return res.status(500).json({
              success: false,
              message: 'Error processing your question',
              error: error.message
            });
          }
        }
      }
    }

    // If we haven't sent a response yet, send appropriate status
    if (buffer.triggerDetected && !buffer.responseSent) {
      return res.status(202).json({
        success: true,
        message: 'Listening...',
        listening: true,
        buffered_text: buffer.collectedQuestion.join(' ')
      });
    }

    return res.status(202).json({
      success: true,
      message: 'Waiting for trigger word',
      listening: true
    });

  } catch (error) {
    console.error('Real-time transcript processing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error processing transcript',
      error: error.message
    });
  }
}

// Webhook handler
app.post('/webhook', async (req, res) => {
  try {
    // Extract the user ID from query parameters (primary) or body (fallback)
    const uid = req.query.uid || req.body.session_id || req.body.uid;

    if (!uid) {
      return res.status(400).json({
        success: false,
        message: 'No user identification provided. Please include uid as a query parameter.'
      });
    }

    // Rate limiting check
    const currentTime = Date.now();
    const cooldownTime = messageBuffer.notificationCooldowns.get(uid) || 0;
    if (currentTime - cooldownTime < 1000) { // 1 second cooldown
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again shortly.'
      });
    }

    // Determine the type of payload (memory object or real-time transcript)
    const isMemory = req.body.id !== undefined &&
      req.body.transcript_segments !== undefined;

    if (isMemory) {
      // Process memory object - this will store it in Firestore under the user's collection
      return await processMemoryObject(req.body, uid, res);
    } else {
      // Process real-time transcript
      return await processRealTimeTranscript(req.body, uid, res);
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  logger.info('Health check endpoint accessed');
  res.status(200).json({ status: 'ok', version: '1.0.0' });
});

// Add queue stats endpoint
app.get('/queue-stats', (req, res) => {
  // Only return queue stats if this is an admin request with correct API key
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const stats = openaiQueue.getStats();
  res.status(200).json({
    status: 'ok',
    queue_stats: stats,
    timestamp: new Date().toISOString()
  });
});

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

app.get('/reflections/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    logger.info(`Retrieving conversation reflections for user ${userId}`);

    const reflectionsRef = db.collection('users')
      .doc(userId)
      .collection(COLLECTIONS.CONVERSATION_REFLECTIONS)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const snapshot = await reflectionsRef.get();
    const reflections = [];

    snapshot.forEach(doc => {
      reflections.push({
        id: doc.id,
        ...doc.data(),
        created_at: doc.data().created_at?.toDate()
      });
    });

    return res.status(200).json({
      success: true,
      user_id: userId,
      reflections: reflections,
      count: reflections.length
    });
  } catch (error) {
    logger.error(`Error retrieving reflections for user ${req.params.userId}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving reflections',
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  logger.info(`AI Mentor running on port ${PORT}`);
});