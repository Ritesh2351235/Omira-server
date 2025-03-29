/**
 * OpenAI API Request Queue
 * 
 * Manages concurrent requests to OpenAI API, implements rate limiting,
 * and handles automatic retries with exponential backoff.
 */

class ApiQueue {
  constructor(options = {}) {
    // Maximum concurrent requests
    this.maxConcurrent = options.maxConcurrent || 50;
    // Maximum retries for rate limit errors
    this.maxRetries = options.maxRetries || 3;
    // Maximum retries for server errors
    this.maxServerErrorRetries = options.maxServerErrorRetries || 1;
    // Base delay for exponential backoff (milliseconds)
    this.baseDelay = options.baseDelay || 2000;

    // Queue state
    this.queue = [];
    this.activeRequests = 0;
    this.logger = options.logger || console;
  }

  /**
   * Add a request to the queue
   * @param {Function} apiCall - Function that returns a Promise for the API call
   * @param {string} description - Description of the request for logging
   * @returns {Promise} Promise that resolves with the API response
   */
  async enqueue(apiCall, description = 'OpenAI API call') {
    return new Promise((resolve, reject) => {
      // Add to queue
      this.queue.push({
        apiCall,
        description,
        resolve,
        reject,
        retries: 0,
        serverErrorRetries: 0
      });

      this.logger.info(`[ApiQueue] Queued: ${description}, Queue length: ${this.queue.length}`);

      // Process queue if possible
      this.processQueue();
    });
  }

  /**
   * Process the next item in the queue if below concurrency limit
   */
  processQueue() {
    if (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      const request = this.queue.shift();
      this.activeRequests++;

      this.logger.info(`[ApiQueue] Processing: ${request.description}, Active: ${this.activeRequests}, Remaining: ${this.queue.length}`);

      this.executeRequest(request);
    }
  }

  /**
   * Execute a request with retry logic
   * @param {Object} request - The request object from the queue
   */
  async executeRequest(request) {
    try {
      const result = await request.apiCall();

      // Success - resolve the promise
      request.resolve(result);
      this.activeRequests--;

      // Process next item if available
      this.processQueue();
    } catch (error) {
      // Handle rate limit errors (429)
      if (error.status === 429 && request.retries < this.maxRetries) {
        request.retries++;
        const delay = this.baseDelay * Math.pow(2, request.retries - 1);

        this.logger.warn(`[ApiQueue] Rate limit hit for: ${request.description}, retry ${request.retries}/${this.maxRetries} in ${delay}ms`);

        // Re-add to front of queue after delay
        setTimeout(() => {
          this.queue.unshift(request);
          this.activeRequests--;
          this.processQueue();
        }, delay);
      }
      // Handle server errors (5xx)
      else if (error.status >= 500 && error.status < 600 && request.serverErrorRetries < this.maxServerErrorRetries) {
        request.serverErrorRetries++;

        this.logger.warn(`[ApiQueue] Server error ${error.status} for: ${request.description}, retry ${request.serverErrorRetries}/${this.maxServerErrorRetries}`);

        // Re-add to front of queue immediately
        this.queue.unshift(request);
        this.activeRequests--;
        this.processQueue();
      }
      // All retries exhausted or other error
      else {
        this.logger.error(`[ApiQueue] Error for: ${request.description}, status: ${error.status}, message: ${error.message}`);

        // Prepare a user-friendly error message
        let friendlyErrorMessage = "Sorry, I'm having trouble processing your request right now.";

        if (error.status === 429) {
          friendlyErrorMessage = "I'm getting too many requests right now. Please try again in a moment.";
        } else if (error.status >= 500) {
          friendlyErrorMessage = "There's a problem with my service right now. Please try again later.";
        }

        // Create an error object with the friendly message
        const enhancedError = new Error(friendlyErrorMessage);
        enhancedError.originalError = error;
        enhancedError.status = error.status;

        // Reject with the enhanced error
        request.reject(enhancedError);
        this.activeRequests--;
        this.processQueue();
      }
    }
  }

  /**
   * Get current queue stats
   * @returns {Object} Queue statistics
   */
  getStats() {
    return {
      queuedRequests: this.queue.length,
      activeRequests: this.activeRequests,
      totalPending: this.queue.length + this.activeRequests
    };
  }
}

module.exports = ApiQueue; 