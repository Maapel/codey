import { getDashboardService } from "./index"

/**
 * State Tracker for Dashboard Integration
 * Monitors AI API calls and task state changes to update dashboard
 */
export class StateTracker {
	private isEnabled: boolean = false
	private sessionName: string = ""
	private currentTaskId: string | null = null
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

		console.log("[StateTracker] Task started:", { taskId, taskDescription })

		if (this.isEnabled) {
			this.updateDashboardState({
				taskId,
				status: "started",
				description: taskDescription,
				apiCalls: 0,
				timestamp: Date.now(),
			})
		}
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
		}
	}

	/**
	 * Track task completion
	 */
	trackTaskCompletion(taskSummary: any): void {
		console.log("[StateTracker] Task completed:", taskSummary)

		if (this.isEnabled && this.currentTaskId) {
			const finalState = {
				taskId: this.currentTaskId,
				status: "completed",
				apiCalls: this.apiCallCount,
				summary: taskSummary,
				completedAt: Date.now(),
			}

			this.updateDashboardState(finalState)

			// Report completion to dashboard service
			const dashboardService = getDashboardService()
			dashboardService.reportTaskCompletion(finalState).catch((error) => {
				console.error("[StateTracker] Failed to report task completion:", error)
			})
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
			})
		}
	}

	/**
	 * Update dashboard state
	 */
	private updateDashboardState(state: any): void {
		// Debounce state updates to avoid too frequent calls
		const now = Date.now()
		if (now - this.lastStateUpdate < 1000) {
			// Max once per second
			return
		}
		this.lastStateUpdate = now

		const dashboardService = getDashboardService()
		dashboardService.updateTaskState(state).catch((error) => {
			console.error("[StateTracker] Failed to update dashboard state:", error)
		})
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
