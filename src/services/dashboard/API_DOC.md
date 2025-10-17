Codey Dashboard API Documentation

This document outlines the API endpoints used by the Codey Dashboard to log agent progress and manage user prompts.

1. Submitting a Checkpoint (Update)

This endpoint is used by the AI agent to report its progress. Each time it's called, a new entry is added to that task's history timeline.

Endpoint: POST /api/codey-checkpoint

Method: POST

Purpose: To log a new update or milestone for a specific task.

Request Payload (application/json)

{
  "taskId": "task-alpha-47",
  "sessionName": "Developing User Authentication",
  "timestamp": 1672531200000,
  "checkpointSummary": "Implemented the password hashing mechanism using bcrypt.",
  "action": "checkpoint_created"
}


Success Response (201 Created)

{
  "message": "Checkpoint for task task-alpha-47 logged."
}


2. Sending a Prompt to the Queue

This is the endpoint used by the dashboard UI when you want to send an instruction to the AI agent.

Endpoint: POST /api/codey-prompt/<id>

Method: POST

Purpose: To add a new instruction for the AI agent to a specific task's queue.

URL Parameter

id: The taskId of the session you are sending the prompt to.

Request Payload (application/json)

{
  "prompt": "Refactor the database connection to use a connection pool."
}


Success Response (201 Created)

{
  "message": "Prompt for Codey task task-alpha-47 has been queued."
}


3. AI Agent Fetching a Prompt

This is the endpoint the AI agent calls to get its next instruction from the queue. It retrieves the oldest prompt for a specific task and immediately removes it from the queue.

Endpoint: GET /api/codey-prompt/<id>

Method: GET

Purpose: For the AI agent to retrieve the next available prompt for a specific task.

URL Parameter

id: The taskId the agent is currently working on.

Success Response (if a prompt exists)

{
  "prompt": "Refactor the database connection to use a connection pool."
}


Success Response (if no prompts are in the queue)

{
  "prompt": "none"
}
