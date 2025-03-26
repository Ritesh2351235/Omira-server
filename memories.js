const { db, admin, timestampToDate, dateToTimestamp } = require('./firebase');
const logger = require('winston');
const uuid = require('uuid');

// Memory status constants
const MEMORY_STATUS = {
  IN_PROGRESS: 'in_progress',
  PROCESSING: 'processing',
  COMPLETED: 'completed'
};

// Post-processing status constants
const POST_PROCESSING_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Post-processing model constants
const POST_PROCESSING_MODELS = {
  FAL_WHISPERX: 'fal_whisperx',
  DEEPGRAM: 'deepgram_streaming',
  SONIOX: 'soniox_streaming',
  SPEECHMATICS: 'speechmatics_streaming'
};

// *****************************
// ********** CRUD *************
// *****************************

/**
 * Upsert a memory document for a user
 * 
 * @param {string} uid - User ID
 * @param {object} memoryData - Memory data object
 * @returns {Promise<void>}
 */
async function upsertMemory(uid, memoryData) {
  try {
    // Remove fields that should be stored separately
    if (memoryData.audio_base64_url) delete memoryData.audio_base64_url;
    if (memoryData.photos) delete memoryData.photos;

    // Convert dates to Firestore timestamps
    if (memoryData.created_at) memoryData.created_at = dateToTimestamp(memoryData.created_at);
    if (memoryData.started_at) memoryData.started_at = dateToTimestamp(memoryData.started_at);
    if (memoryData.finished_at) memoryData.finished_at = dateToTimestamp(memoryData.finished_at);

    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryData.id);

    await memoryRef.set(memoryData, { merge: true });
    logger.info(`Memory ${memoryData.id} upserted for user ${uid}`);
    return memoryData.id;
  } catch (error) {
    logger.error(`Error upserting memory for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get a memory by ID
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @returns {Promise<object|null>} - Memory object or null
 */
async function getMemory(uid, memoryId) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);
    const memoryDoc = await memoryRef.get();

    if (!memoryDoc.exists) {
      logger.warn(`Memory ${memoryId} not found for user ${uid}`);
      return null;
    }

    const memoryData = memoryDoc.data();

    // Convert Firestore timestamps to dates
    if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
    if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
    if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

    return memoryData;
  } catch (error) {
    logger.error(`Error getting memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get memories for a user with pagination and filtering
 * 
 * @param {string} uid - User ID
 * @param {number} limit - Number of memories to return
 * @param {number} offset - Offset for pagination
 * @param {boolean} includeDiscarded - Whether to include discarded memories
 * @param {Array<string>} statuses - Filter by memory statuses
 * @returns {Promise<Array<object>>} - Array of memory objects
 */
async function getMemories(uid, limit = 100, offset = 0, includeDiscarded = false, statuses = []) {
  try {
    let query = db.collection('users').doc(uid)
      .collection('memories')
      .where('deleted', '==', false);

    if (!includeDiscarded) {
      query = query.where('discarded', '==', false);
    }

    if (statuses && statuses.length > 0) {
      query = query.where('status', 'in', statuses);
    }

    query = query.orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const snapshot = await query.get();
    const memories = [];

    snapshot.forEach(doc => {
      const memoryData = doc.data();

      // Convert Firestore timestamps to dates
      if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
      if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
      if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

      memories.push(memoryData);
    });

    return memories;
  } catch (error) {
    logger.error(`Error getting memories for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Update a memory
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {object} memoryData - Updated memory data
 * @returns {Promise<void>}
 */
async function updateMemory(uid, memoryId, memoryData) {
  try {
    // Convert dates to Firestore timestamps
    if (memoryData.created_at) memoryData.created_at = dateToTimestamp(memoryData.created_at);
    if (memoryData.started_at) memoryData.started_at = dateToTimestamp(memoryData.started_at);
    if (memoryData.finished_at) memoryData.finished_at = dateToTimestamp(memoryData.finished_at);

    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update(memoryData);
    logger.info(`Memory ${memoryId} updated for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Update a memory's title
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {string} title - New title
 * @returns {Promise<void>}
 */
async function updateMemoryTitle(uid, memoryId, title) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      'structured.title': title
    });

    logger.info(`Title updated for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating title for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Mark a memory as deleted
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @returns {Promise<void>}
 */
async function deleteMemory(uid, memoryId) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      deleted: true
    });

    logger.info(`Memory ${memoryId} marked as deleted for user ${uid}`);
  } catch (error) {
    logger.error(`Error deleting memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Filter memories by date range
 * 
 * @param {string} uid - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array<object>>} - Array of memory objects
 */
async function filterMemoriesByDate(uid, startDate, endDate) {
  try {
    const startTimestamp = dateToTimestamp(startDate);
    const endTimestamp = dateToTimestamp(endDate);

    const query = db.collection('users').doc(uid)
      .collection('memories')
      .where('created_at', '>=', startTimestamp)
      .where('created_at', '<=', endTimestamp)
      .where('deleted', '==', false)
      .where('discarded', '==', false)
      .orderBy('created_at', 'desc');

    const snapshot = await query.get();
    const memories = [];

    snapshot.forEach(doc => {
      const memoryData = doc.data();

      // Convert Firestore timestamps to dates
      if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
      if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
      if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

      memories.push(memoryData);
    });

    return memories;
  } catch (error) {
    logger.error(`Error filtering memories by date for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get memories by IDs
 * 
 * @param {string} uid - User ID
 * @param {Array<string>} memoryIds - Array of memory IDs
 * @returns {Promise<Array<object>>} - Array of memory objects
 */
async function getMemoriesByIds(uid, memoryIds) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoriesRef = userRef.collection('memories');

    const promises = memoryIds.map(id => memoriesRef.doc(id).get());
    const docs = await Promise.all(promises);

    const memories = [];
    docs.forEach(doc => {
      if (doc.exists) {
        const memoryData = doc.data();

        // Skip deleted or discarded memories
        if (memoryData.deleted || memoryData.discarded) return;

        // Convert Firestore timestamps to dates
        if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
        if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
        if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

        memories.push(memoryData);
      }
    });

    return memories;
  } catch (error) {
    logger.error(`Error getting memories by IDs for user ${uid}:`, error);
    throw error;
  }
}

// **************************************
// ********** STATUS *************
// **************************************

/**
 * Get a memory that is in progress
 * 
 * @param {string} uid - User ID
 * @returns {Promise<object|null>} - Memory object or null
 */
async function getInProgressMemory(uid) {
  try {
    const userRef = db.collection('users').doc(uid);
    const query = userRef.collection('memories')
      .where('status', '==', MEMORY_STATUS.IN_PROGRESS)
      .limit(1);

    const snapshot = await query.get();

    if (snapshot.empty) {
      return null;
    }

    const memoryData = snapshot.docs[0].data();

    // Convert Firestore timestamps to dates
    if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
    if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
    if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

    return memoryData;
  } catch (error) {
    logger.error(`Error getting in-progress memory for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get memories that are in processing state
 * 
 * @param {string} uid - User ID
 * @returns {Promise<Array<object>>} - Array of memory objects
 */
async function getProcessingMemories(uid) {
  try {
    const userRef = db.collection('users').doc(uid);
    const query = userRef.collection('memories')
      .where('status', '==', MEMORY_STATUS.PROCESSING);

    const snapshot = await query.get();
    const memories = [];

    snapshot.forEach(doc => {
      const memoryData = doc.data();

      // Convert Firestore timestamps to dates
      if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
      if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
      if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

      memories.push(memoryData);
    });

    return memories;
  } catch (error) {
    logger.error(`Error getting processing memories for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Update a memory's status
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {string} status - New status
 * @returns {Promise<void>}
 */
async function updateMemoryStatus(uid, memoryId, status) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      status: status
    });

    logger.info(`Status updated to ${status} for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating status for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Mark a memory as discarded
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @returns {Promise<void>}
 */
async function setMemoryAsDiscarded(uid, memoryId) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      discarded: true
    });

    logger.info(`Memory ${memoryId} marked as discarded for user ${uid}`);
  } catch (error) {
    logger.error(`Error marking memory ${memoryId} as discarded for user ${uid}:`, error);
    throw error;
  }
}

// *********************************
// ********** CALENDAR *************
// *********************************

/**
 * Update a memory's events
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {Array<object>} events - Array of events
 * @returns {Promise<void>}
 */
async function updateMemoryEvents(uid, memoryId, events) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      'structured.events': events
    });

    logger.info(`Events updated for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating events for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

// *********************************
// ******** ACTION ITEMS ***********
// *********************************

/**
 * Update a memory's action items
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {Array<object>} actionItems - Array of action items
 * @returns {Promise<void>}
 */
async function updateMemoryActionItems(uid, memoryId, actionItems) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      'structured.action_items': actionItems
    });

    logger.info(`Action items updated for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating action items for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

// ******************************
// ********** OTHER *************
// ******************************

/**
 * Update a memory's finished_at timestamp
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {Date} finishedAt - Finished at timestamp
 * @returns {Promise<void>}
 */
async function updateMemoryFinishedAt(uid, memoryId, finishedAt) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      finished_at: dateToTimestamp(finishedAt)
    });

    logger.info(`Finished at timestamp updated for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating finished at timestamp for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Update a memory's transcript segments
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {Array<object>} segments - Array of transcript segments
 * @returns {Promise<void>}
 */
async function updateMemorySegments(uid, memoryId, segments) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      transcript_segments: segments
    });

    logger.info(`Transcript segments updated for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error updating transcript segments for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

// ***********************************
// ********** VISIBILITY *************
// ***********************************

/**
 * Set a memory's visibility
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {string} visibility - Visibility value ('private', 'public', etc.)
 * @returns {Promise<void>}
 */
async function setMemoryVisibility(uid, memoryId, visibility) {
  try {
    const userRef = db.collection('users').doc(uid);
    const memoryRef = userRef.collection('memories').doc(memoryId);

    await memoryRef.update({
      visibility: visibility
    });

    logger.info(`Visibility set to ${visibility} for memory ${memoryId} for user ${uid}`);
  } catch (error) {
    logger.error(`Error setting visibility for memory ${memoryId} for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get the memory closest to the given timestamps
 * 
 * @param {string} uid - User ID
 * @param {number} startTimestamp - Start timestamp in seconds
 * @param {number} endTimestamp - End timestamp in seconds
 * @returns {Promise<object|null>} - Memory object or null
 */
async function getClosestMemoryToTimestamps(uid, startTimestamp, endTimestamp) {
  try {
    // Convert timestamps to Date objects and add/subtract thresholds
    const startDate = new Date(startTimestamp * 1000);
    const endDate = new Date(endTimestamp * 1000);

    // Add buffer of 2 minutes on each side
    const startThreshold = new Date(startDate.getTime() - 2 * 60 * 1000); // 2 minutes before
    const endThreshold = new Date(endDate.getTime() + 2 * 60 * 1000); // 2 minutes after

    logger.info(`Looking for memories between ${startThreshold.toISOString()} and ${endThreshold.toISOString()}`);

    const query = db.collection('users').doc(uid)
      .collection('memories')
      .where('finished_at', '>=', dateToTimestamp(startThreshold))
      .where('started_at', '<=', dateToTimestamp(endThreshold))
      .where('deleted', '==', false)
      .orderBy('created_at', 'desc');

    const snapshot = await query.get();
    const memories = [];

    snapshot.forEach(doc => {
      const memoryData = doc.data();

      // Convert Firestore timestamps to JavaScript Date objects
      if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
      if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
      if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

      memories.push(memoryData);
    });

    if (memories.length === 0) {
      return null;
    }

    // Find the memory with the closest start or end timestamp
    let closestMemory = null;
    let minDiff = Infinity;

    for (const memory of memories) {
      const memoryStartTimestamp = memory.started_at.getTime() / 1000;
      const memoryEndTimestamp = memory.finished_at.getTime() / 1000;

      const diff1 = Math.abs(memoryStartTimestamp - startTimestamp);
      const diff2 = Math.abs(memoryEndTimestamp - endTimestamp);

      if (diff1 < minDiff || diff2 < minDiff) {
        minDiff = Math.min(diff1, diff2);
        closestMemory = memory;
      }
    }

    return closestMemory;
  } catch (error) {
    logger.error(`Error getting closest memory to timestamps for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Get the last completed memory for a user
 * 
 * @param {string} uid - User ID
 * @returns {Promise<object|null>} - Memory object or null
 */
async function getLastCompletedMemory(uid) {
  try {
    const query = db.collection('users').doc(uid)
      .collection('memories')
      .where('deleted', '==', false)
      .where('status', '==', MEMORY_STATUS.COMPLETED)
      .orderBy('created_at', 'desc')
      .limit(1);

    const snapshot = await query.get();

    if (snapshot.empty) {
      return null;
    }

    const memoryData = snapshot.docs[0].data();

    // Convert Firestore timestamps to dates
    if (memoryData.created_at) memoryData.created_at = timestampToDate(memoryData.created_at);
    if (memoryData.started_at) memoryData.started_at = timestampToDate(memoryData.started_at);
    if (memoryData.finished_at) memoryData.finished_at = timestampToDate(memoryData.finished_at);

    return memoryData;
  } catch (error) {
    logger.error(`Error getting last completed memory for user ${uid}:`, error);
    throw error;
  }
}

/**
 * Update memory metadata for storing analysis results
 * 
 * @param {string} uid - User ID
 * @param {string} memoryId - Memory ID
 * @param {object} metadata - Metadata to update
 * @returns {Promise<boolean>} - Success status
 */
async function updateMemoryMetadata(uid, memoryId, metadata) {
  try {
    const memoryRef = db.collection('users').doc(uid)
      .collection('memories').doc(memoryId);

    await memoryRef.update({
      metadata: admin.firestore.FieldValue.arrayUnion(metadata),
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info(`Updated metadata for memory ${memoryId}`);
    return true;
  } catch (error) {
    logger.error(`Error updating metadata for memory ${memoryId}:`, error);
    return false;
  }
}

module.exports = {
  // CRUD
  upsertMemory,
  getMemory,
  getMemories,
  updateMemory,
  updateMemoryTitle,
  deleteMemory,
  filterMemoriesByDate,
  getMemoriesByIds,

  // Status
  getInProgressMemory,
  getProcessingMemories,
  updateMemoryStatus,
  setMemoryAsDiscarded,

  // Calendar
  updateMemoryEvents,

  // Action Items
  updateMemoryActionItems,

  // Other
  updateMemoryFinishedAt,
  updateMemorySegments,

  // Visibility
  setMemoryVisibility,

  // Timestamps
  getClosestMemoryToTimestamps,
  getLastCompletedMemory,

  // Constants
  MEMORY_STATUS,
  POST_PROCESSING_STATUS,
  POST_PROCESSING_MODELS,

  // Metadata
  updateMemoryMetadata
}; 