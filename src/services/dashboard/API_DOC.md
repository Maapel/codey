Codey Dashboard API Documentation

This document outlines the API endpoints and expected workflow for an AI agent interacting with the Codey Dashboard. The system is designed around task states to minimize unnecessary polling and provide granular control over the agent's lifecycle.

Agent Workflow & States

The agent operates in three distinct states: Running, Completed, and Cancelled.

Running State: This is the default active state. The agent works on its task autonomously. It only communicates with the server to post progress updates and does not poll for new instructions. Its instructions are piggybacked on the response to its updates.

Completed State: The agent enters this state after successfully finishing all of its work for a given task. In this state, it begins polling an endpoint to automatically receive the next prompt from its queue.

Cancelled State: The agent enters this state only after being told to cancel by the server (due to user action) or after being cancelled locally. In this state, the agent stops its current work and begins polling the same endpoint, but it will wait for explicit user commands (e.g., resume, start next in queue, or an urgent new prompt).

1. Agent's Primary Loop (Running State)

This is the main endpoint the agent uses to post progress updates. The response to this call is critical as it can command the agent to change state.

Endpoint: POST /api/codey-checkpoint

When to Call: When the agent has a progress update to report.

Request Payload (application/json)

{
  "taskId": "task-alpha-47",
  "sessionName": "Developing User Authentication",
  "timestamp": 1672531200000,
  "checkpointSummary": "Implemented the password hashing mechanism.",
  "completed": false
}


completed (boolean, optional):

Set this to true in the final checkpoint for a task. This tells the server to transition the task's state to completed.

Omit or set to false for all other progress updates.

Response (200 OK)

The response dictates the agent's next action.

{
  "cancel": false
}


cancel (boolean):

If true, the agent MUST immediately stop its current work and enter the Cancelled State (see section 2).

If false, the agent should continue its work as normal.

2. Agent's Idle States (Polling for Instructions)

The agent only uses this endpoint when it is in the Cancelled or Completed state.

Endpoint: GET /api/task/<task_id>/instructions

When to Call: Repeatedly, after either receiving "cancel": true or sending a final checkpoint with "completed": true.

URL Parameter

task_id: The taskId of the agent.

Possible Responses (200 OK)

The server's response depends on the task's current state and any user actions.

A) If Task State is Completed:
The server will automatically try to serve the next prompt from the queue.

Next Prompt Available:

{ "prompt": "Start working on the next queued item." }


Agent Action: Stop polling, transition to Running state, and begin work on the new prompt.

Queue is Empty:

{ "prompt": null }


Agent Action: Remain in Completed state and continue polling.

B) If Task State is Cancelled:
The server waits for a specific command from the user.

Urgent Prompt Sent: The user has submitted a high-priority prompt that skips the queue.

{ "prompt": "URGENT: Stop what you were doing and do this now." }


Agent Action: Stop polling, transition to Running state, and begin work on the urgent prompt.

"Process Queue" Command: The user has instructed the agent to start the next item in the queue.

{ "prompt": "Start working on the next queued item." }


Agent Action: Stop polling, transition to Running state, and begin work on the prompt from the queue.

Resume Command: The user has clicked "Resume".

{ "resume": true }


Agent Action: Stop polling, transition to Running state, and resume the previous task from where it left off.

"Keep Polling" Signal: No user action has been taken yet.

{ "prompt": null, "resume": false }


Agent Action: Remain in Cancelled state and continue polling.

3. Prompt & Queue Management

The dashboard allows users to manage a queue of prompts for each task. This queue can be modified at any time (reordering, deleting, adding).

When a Cancelled or Completed agent is given a new prompt to work on, it is typically the next one from this queue.

Urgent Prompts: For a Cancelled task, the user has a special option to send a prompt that is delivered immediately to the agent, bypassing the queue entirely.

4. Agent-Side State Sync

If the agent's state is changed by its local UI (e.g., a button in a VS Code extension), it MUST call the appropriate endpoint to keep the dashboard synchronized.

Endpoint: POST /api/agent/task/<task_id>/cancel

Endpoint: POST /api/agent/task/<task_id>/resume

Success Response (200 OK)

{
  "message": "Server state for <task_id> synced to '<status>'."
}
