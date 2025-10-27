import { getDashboardIntegrationManager } from "./DashboardIntegrationManager"
import { getDashboardService } from "./index"
import { getPromptManager } from "./PromptManager"

/**
 * Agent States as defined in API documentation
 */
export type AgentState = "running" | "completed" | "cancelled"

/**
 * State Tracker for Dashboard Integration
 * Monitors AI API calls and task state changes to update dashboard
 * Manages agent state transitions: Running -> Completed/Cancelled -> Running
 */
export class StateTracker {
	private isEnabled: boolean = false
	private sessionName: string = ""
	private currentTaskId: string | null = null
	private currentAgentState: AgentState = "running"
	private apiCallCount: number = 0
	private lastStateUpdate: number = 0

	constructor() {
		console.log("[StateTracker] Initialized")
	}

	/**
	 * Configure the state tracker with dashboard settings
	 */
	configure(enabled: boolean, sessionName: string): void {
		this.isEnabled = enabled
		this.sessionName = sessionName

		console.log("[StateTracker] Configured:", {
			enabled: this.isEnabled,
			sessionName: this.sessionName,
		})
	}

	/**
	 * Track the start of a new task
	 */
	trackTaskStart(taskId: string, taskDescription: string): void {
		this.currentTaskId = taskId
		this.apiCallCount = 0

		// Update dashboard manager with task ID
		const dashboardManager = getDashboardIntegrationManager()
		dashboardManager.setDashboardTaskId(taskId)

		console.log("[StateTracker] Task started:", { taskId, taskDescription })

		if (this.isEnabled) {
			this.updateDashboardState({
				taskId,
				status: "started",
				description: taskDescription,
				apiCalls: 0,
				timestamp: Date.now(),
			}).catch((error) => {
				console.error("[StateTracker] Failed to update dashboard on task start:", error)
			})
		}
	}

	/**
	 * Handle dashboard cancel command - use same flow as UI cancel button
	 */
	handleDashboardCancel(): void {
		console.log("[StateTracker] Dashboard sent cancel command - using same flow as UI cancel")

		// Use the same programmatic flow as the UI cancel button
		this.cancelTaskWithDashboardMessage()
	}

	/**
	 * Track AI API call
	 */
	trackApiCall(request: any, response?: any): void {
		this.apiCallCount++

		console.log("[StateTracker] API call tracked:", {
			callCount: this.apiCallCount,
			hasResponse: !!response,
		})

		if (this.isEnabled && this.currentTaskId) {
			this.updateDashboardState({
				taskId: this.currentTaskId,
				status: "in_progress",
				apiCalls: this.apiCallCount,
				lastApiCall: Date.now(),
				timestamp: Date.now(),
			})
				.then((result) => {
					// HERE IS WHERE THE DASHBOARD RESPONSE IS PROCESSED
					console.log("[StateTracker] Dashboard response result:", result)

					// Check if dashboard sent a cancel command - only process if task is running
					if (result && result.cancel && this.currentAgentState === "running") {
						console.log("[StateTracker] Received cancel command from dashboard, cancelling task")
						this.handleDashboardCancel()
					} else if (result && result.cancel && this.currentAgentState !== "running") {
						console.log("[StateTracker] Ignoring cancel command - task is not in running state:", {
							currentState: this.currentAgentState,
							currentTaskId: this.currentTaskId,
						})
					}
				})
				.catch((error) => {
					console.error("[StateTracker] Error updating dashboard state:", error)
				})
		}
	}

	/**
	 * Track task completion and transition to completed state
	 */
	trackTaskCompletion(taskSummary: any): void {
		console.log("[StateTracker] Task completed:", taskSummary)

		if (this.isEnabled && this.currentTaskId) {
			this.transitionToState("completed")

			const finalState = {
				taskId: this.currentTaskId,
				status: "completed",
				apiCalls: this.apiCallCount,
				summary: taskSummary,
				completedAt: Date.now(),
			}

			this.updateDashboardState(finalState).catch((error) => {
				console.error("[StateTracker] Failed to update dashboard on completion:", error)
			})

			// Report completion to dashboard service
			const dashboardService = getDashboardService()
			dashboardService.reportTaskCompletion(finalState).catch((error) => {
				console.error("[StateTracker] Failed to report task completion:", error)
			})

			// Polling for resume instructions removed for now
		}

		// Reset for next task
		this.currentTaskId = null
		this.apiCallCount = 0
	}

	/**
	 * Track task progress update
	 */
	trackProgressUpdate(progress: number, currentStep: string): void {
		console.log("[StateTracker] Progress update:", { progress, currentStep })

		if (this.isEnabled && this.currentTaskId) {
			this.updateDashboardState({
				taskId: this.currentTaskId,
				status: "in_progress",
				progress,
				currentStep,
				apiCalls: this.apiCallCount,
				timestamp: Date.now(),
			}).catch((error) => {
				console.error("[StateTracker] Failed to update dashboard on progress:", error)
			})
		}
	}

	/**
	 * Update dashboard state
	 */
	private async updateDashboardState(state: any): Promise<{ success: boolean; cancel?: boolean }> {
		// Debounce state updates to avoid too frequent calls
		const now = Date.now()
		if (now - this.lastStateUpdate < 1000) {
			// Max once per second
			return { success: false }
		}
		this.lastStateUpdate = now

		const dashboardService = getDashboardService()
		try {
			return await dashboardService.updateTaskState(state)
		} catch (error) {
			console.error("[StateTracker] Failed to update dashboard state:", error)
			return { success: false }
		}
	}

	/**
	 * Transition agent to a new state
	 */
	private transitionToState(newState: AgentState): void {
		const oldState = this.currentAgentState
		this.currentAgentState = newState

		console.log(`[StateTracker] State transition: ${oldState} -> ${newState}`, {
			taskId: this.currentTaskId,
		})
	}

	/**
	 * Cancel the current task and add a dashboard cancellation message to the UI
	 */
	private async cancelTaskWithDashboardMessage(): Promise<void> {
		try {
			// Get the controller instance from the WebviewProvider
			const { WebviewProvider } = require("@core/webview")
			const webviewProvider = WebviewProvider.getInstance()
			const controller = webviewProvider.controller

			if (!controller?.task) {
				console.warn("[StateTracker] No active task to cancel")
				return
			}

			// Add a message to the UI indicating dashboard cancellation
			await controller.task.say("text", "🔄 Task cancelled by dashboard. Waiting for new instructions...")

			// Cancel the task
			await controller.cancelTask("dashboard_cancelled")
		} catch (error) {
			console.error("[StateTracker] Error cancelling task with dashboard message:", error)
		}
	}

	/**
	 * Trigger task creation with a new prompt
	 */
	private triggerTaskCreation(prompt: string): void {
		try {
			// Import and use the controller to create a new task
			const controllerModule = require("@core/controller")
			// This would need to be implemented in the controller to handle external task creation
			console.log("[StateTracker] New prompt received from dashboard:", prompt.substring(0, 50) + "...")
		} catch (error) {
			console.error("[StateTracker] Error triggering task creation:", error)
		}
	}

	/**
	 * Trigger task resume
	 */
	private async triggerTaskResume(): Promise<void> {
		try {
			// Get the controller instance from the WebviewProvider
			const { WebviewProvider } = require("@core/webview")
			const webviewProvider = WebviewProvider.getInstance()
			const controller = webviewProvider.controller

			if (!controller?.task) {
				console.warn("[StateTracker] No active task to resume")
				return
			}

			// Add a message to the UI indicating dashboard resume
			await controller.task.say("text", "🔄 Task resumed by dashboard. Continuing from where we left off...")

			// Resume the task by continuing the task loop
			// Since the task was cancelled and restored from history, we can continue from the current state
			const task = controller.task

			// Create user content to continue the task loop
			const userContent: any[] = [
				{
					type: "text",
					text: "Continuing the task from where it was cancelled. Please proceed with the next steps.",
				},
			]

			// Continue the task loop
			await task.initiateTaskLoop(userContent)
		} catch (error) {
			console.error("[StateTracker] Error triggering task resume:", error)
		}
	}

	/**
	 * Show popup notification when task is resumed from dashboard
	 */
	private showResumePopup(): void {
		try {
			const { window } = require("vscode")
			window.showInformationMessage("Task resumed by dashboard", "OK")
		} catch (error) {
			console.error("[StateTracker] Error showing resume popup:", error)
		}
	}

	/**
	 * Track task cancellation
	 */
	trackTaskCancellation(reason?: string): void {
		console.log("[StateTracker] Task cancelled:", { reason, taskId: this.currentTaskId })

		if (this.isEnabled && this.currentTaskId) {
			this.transitionToState("cancelled")

			const cancelState = {
				taskId: this.currentTaskId,
				status: "cancelled",
				reason: reason || "user_cancelled",
				cancelledAt: Date.now(),
			}

			this.updateDashboardState(cancelState)

			// Start polling for resume instructions after cancellation
			this.startPollingForInstructions()
		}
	}

	/**
	 * Start polling for instructions after cancellation
	 */
	private startPollingForInstructions(): void {
		// Start the prompt manager polling
		const promptManager = getPromptManager()
		promptManager.startPolling()
	}

	/**
	 * Get current tracking status
	 */
	getStatus(): {
		enabled: boolean
		sessionName: string
		currentTaskId: string | null
		apiCallCount: number
	} {
		return {
			enabled: this.isEnabled,
			sessionName: this.sessionName,
			currentTaskId: this.currentTaskId,
			apiCallCount: this.apiCallCount,
		}
	}
}

// Global state tracker instance
let stateTrackerInstance: StateTracker | null = null

/**
 * Get the global state tracker instance
 */
export function getStateTracker(): StateTracker {
	if (!stateTrackerInstance) {
		stateTrackerInstance = new StateTracker()
	}
	return stateTrackerInstance
}

/**
 * Reset the state tracker instance (useful for testing)
 */
export function resetStateTracker(): void {
	stateTrackerInstance = null
}
