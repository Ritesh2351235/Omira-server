# Omi Server with Firestore Integration

This repository contains the server-side code for Omi, with Firebase/Firestore integration for memory storage and retrieval.

## Setup

### Prerequisites

- Node.js v16 or higher
- Firebase account with Firestore enabled

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

### Firebase Setup

1. Create a Firebase project at https://console.firebase.google.com/
2. Enable Firestore in your project
3. Generate a service account key:
   - Go to Project Settings > Service accounts
   - Click "Generate new private key"
   - Save the JSON file securely

4. Set up environment variables:
   - Create a `.env` file in the project root with the following content:

```
FIREBASE_SERVICE_ACCOUNT=path/to/your-service-account-file.json
# OR you can embed the entire service account JSON
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"your-project-id",...}
```

### Running the Server

```bash
npm start
```

## Features

### Memory Management

The system includes functionality for storing and retrieving memory objects in Firestore:

- Create, read, update, and delete memories
- Filter memories by date, status, or other criteria
- Handle transcript segments and structured data

### Daily Summaries

Generate and retrieve daily summaries of memories:

- Create summaries for specific dates
- Retrieve existing summaries
- Generate new summaries based on memories from a specific date

## API Endpoints

### Webhook

The `/webhook` endpoint handles both real-time transcription data and memory objects:

- Real-time transcription: Processes incoming transcription segments
- Memory objects: Processes complete memory objects with transcript segments and structured data

## Codebase Structure

- `server/serverv2.js` - Main server file with webhook handlers
- `server/firebase.js` - Firebase initialization and utilities
- `server/memories.js` - Memory management functions
- `server/daily-summaries.js` - Daily summary generation and retrieval

## Required NPM Packages

To run this project, the following packages are required:

```
firebase-admin
dotenv
winston
uuid
express
``` 