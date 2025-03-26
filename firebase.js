const admin = require('firebase-admin');
const dotenv = require('dotenv');
const winston = require('winston');
const path = require('path');

// Import logger from your existing setup or create a new one
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'firebase.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

dotenv.config();

// Initialize Firebase
let firebaseConfig;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Try to parse service account from environment variable
    try {
      firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      logger.info('Firebase initialized with service account from environment variable');
    } catch (error) {
      logger.error('Failed to parse Firebase service account from environment variable:', error);
      throw new Error('Invalid Firebase service account JSON in environment variable');
    }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    // Try to load service account from file
    try {
      const serviceAccountPath = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      firebaseConfig = require(serviceAccountPath);
      logger.info('Firebase initialized with service account from file:', serviceAccountPath);
    } catch (error) {
      logger.error('Failed to load Firebase service account from file:', error);
      throw new Error(`Invalid Firebase service account file path: ${process.env.FIREBASE_SERVICE_ACCOUNT_PATH}`);
    }
  } else {
    throw new Error('No Firebase configuration provided. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH in .env');
  }

  // Initialize the app
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });

  logger.info('Firebase Admin SDK initialized successfully');
} catch (error) {
  logger.error('Firebase initialization error:', error);
  throw error;
}

// Get Firestore database
const db = admin.firestore();

// Define collection names
const COLLECTIONS = {
  USERS: 'users',
  MEMORIES: 'memories',           // Subcollection under users/{userId}
  DAILY_SUMMARIES: 'dailySummaries', // Subcollection under users/{userId}
  USER_CONTEXT: 'userContext',    // Subcollection under users/{userId}
  TASKS: 'tasks',                 // Subcollection under users/{userId}
  NUTRITION_LOGS: 'nutritionLogs', // Collection
  HEALTH_LOGS: 'healthLogs',      // Collection
  CONVERSATION_REFLECTIONS: 'conversationReflections'  // Subcollection under users/{userId}
};

// Initialize collections with schema validation
async function initializeCollections() {
  try {
    // Create the users collection first
    const usersCollection = db.collection(COLLECTIONS.USERS);
    const usersSnapshot = await usersCollection.limit(1).get();

    if (usersSnapshot.empty) {
      logger.info(`Initializing collection: ${COLLECTIONS.USERS}`);
      // Add a template user document to initialize the collection
      await usersCollection.doc('template_user').set({
        description: 'Template user for collection initialization',
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Create standalone collections (not subcollections)
    const standaloneCollections = [
      COLLECTIONS.NUTRITION_LOGS,
      COLLECTIONS.HEALTH_LOGS
    ];

    for (const collectionName of standaloneCollections) {
      const collection = db.collection(collectionName);
      const snapshot = await collection.limit(1).get();

      if (snapshot.empty) {
        logger.info(`Initializing standalone collection: ${collectionName}`);
        await collection.doc('schema_version_1').set({
          version: 1,
          description: `Initial schema for ${collectionName}`,
          created_at: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    logger.info('Collections initialized successfully');
  } catch (error) {
    logger.error('Error initializing collections:', error);
    throw error;
  }
}

// Helper function to convert Firebase timestamp to Date
const timestampToDate = (timestamp) => {
  if (!timestamp) return null;
  return timestamp.toDate();
};

// Helper function to convert Date to Firebase timestamp
const dateToTimestamp = (date) => {
  if (!date) return null;

  // If it's already a Firestore Timestamp, return it
  if (date && typeof date.toMillis === 'function') {
    return date;
  }

  // If it's a string, convert to Date
  if (typeof date === 'string') {
    date = new Date(date);
  }

  // Ensure it's a valid Date object before calling getTime
  if (date instanceof Date && !isNaN(date.getTime())) {
    return admin.firestore.Timestamp.fromDate(date);
  }

  // Return null for invalid dates
  return null;
};

// Helper function to generate UUID from seed
const documentIdFromSeed = (seed) => {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(seed).digest();
  const uuidHex = hash.slice(0, 16).toString('hex');
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
};

// Create firestore indexes needed for the application
async function createRequiredIndexes() {
  try {
    logger.info('Checking and creating required indexes');

    // The Firebase Admin SDK does not directly support index creation
    // This function is a placeholder for documenting needed indexes
    // Indexes must be created in the Firebase Console or via Firebase CLI

    /* Required indexes:
    
    1. Collection: users/{userId}/memories
       Fields: created_at (desc), deleted (asc), discarded (asc)
       
    2. Collection: users/{userId}/memories
       Fields: created_at (asc) for date range queries
       
    3. Collection: users/{userId}/dailySummaries
       Fields: date (desc)
    */

    logger.info('Index documentation complete - please create these indexes in Firebase Console');
    return true;
  } catch (error) {
    logger.error('Error documenting indexes:', error);
    return false;
  }
}

// Don't initialize collections automatically - will be called explicitly when needed
// initializeCollections().catch(error => {
//   logger.error('Failed to initialize collections:', error);
// });

module.exports = {
  db,
  admin,
  COLLECTIONS,
  timestampToDate,
  dateToTimestamp,
  documentIdFromSeed,
  createRequiredIndexes,
  initializeCollections
}; 