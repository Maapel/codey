import { DashboardSettings } from "@shared/DashboardSettings"
import { getDashboardIntegrationManager } from "./DashboardIntegrationManager"

/**
 * Dashboard Integration Service
 * Handles communication with external dashboard API for AI agent hub integration
 */
export class DashboardService {
	private config: DashboardSettings | null = null
	private isEnabled: boolean = false
	private sessionName: string = ""
	private apiEndpoint?: string

	constructor() {
		console.log("[DashboardService] Initialized")
	}

	/**
	 * Configure the dashboard service with user settings
	 */
	configure(settings: DashboardSettings): void {
		this.config = settings
		this.isEnabled = settings.enabled
		this.sessionName = settings.sessionName
		this.apiEndpoint = settings.dashboardUrl

		console.log("[DashboardService] Configured:", {
			enabled: this.isEnabled,
			sessionName: this.sessionName,
			endpoint: this.getApiEndpoint(),
		})
	}

	/**
	 * Check if dashboard integration is enabled
	 */
	isDashboardEnabled(): boolean {
		return this.isEnabled && this.sessionName.length > 0
	}

	/**
	 * Get current session name
	 */
	getSessionName(): string {
		return this.sessionName
	}

	/**
	 * Get API endpoint URL (including fallback if not configured)
	 */
	getApiEndpoint(): string {
		return this.apiEndpoint || "https://maadhav17.pythonanywhere.com/api/codey-checkpoint"
	}

	/**
	 * Update current task state to dashboard
	 * This will be called after each AI API call
	 */
	async updateTaskState(taskState: any): Promise<{ success: boolean; cancel?: boolean }> {
		if (!this.isDashboardEnabled()) {
			console.log("[DashboardService] Dashboard not enabled, skipping state update")
			return { success: false }
		}

		try {
			console.log("[DashboardService] Updating task state:", taskState)

			// Use dashboard task ID if available, otherwise use provided taskId
			const dashboardManager = getDashboardIntegrationManager()
			const dashboardTaskId = dashboardManager.getDashboardTaskId()

			// Prepare checkpoint data according to API_DOC.md format
			const checkpointData = {
				taskId: dashboardTaskId || taskState.taskId, // Prioritize dashboard task ID
				sessionName: this.sessionName,
				timestamp: taskState.timestamp || Date.now(),
				checkpointSummary: taskState.description || taskState.currentStep || "Progress update",
				completed: false, // This is for final completion, not progress updates
			}

			console.log("[DashboardService] Sending checkpoint data:", checkpointData)

			// Make actual API call to checkpoint endpoint
			const response = await this.makeApiCall(checkpointData)

			// HERE IS WHERE THE RESPONSE IS CAUGHT AND PROCESSED
			console.log("[DashboardService] Dashboard response:", response)

			// Check for cancel command in response
			const shouldCancel = response && response.cancel === true
			if (shouldCancel) {
				console.log("[DashboardService] Received cancel command from dashboard")
			}

			return { success: true, cancel: shouldCancel }
		} catch (error) {
			console.error("[DashboardService] Failed to update task state:", error)
			return { success: false }
		}
	}

	/**
	 * Poll for instructions when agent is in idle state (completed/cancelled)
	 * Returns instructions for next action or null if no instructions available
	 * Follows API_DOC.md specification for polling behavior
	 */
	async pollForInstructions(taskId: string): Promise<any> {
		if (!this.isDashboardEnabled()) {
			return null
		}

		try {
			console.log("[DashboardService] Polling for instructions:", { taskId })

			// Construct the instructions endpoint URL as per API_DOC.md
			let baseEndpoint = this.apiEndpoint || "https://maadhav17.pythonanywhere.com"
			baseEndpoint = baseEndpoint.replace(/\/$/, "") // Remove trailing slash
			const instructionsEndpoint = `${baseEndpoint}/api/task/${taskId}/instructions`

			console.log("[DashboardService] Polling instructions from:", instructionsEndpoint)

			const response = await fetch(instructionsEndpoint, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const result = await response.json()
			console.log("[DashboardService] Instructions poll result:", result)

			// Validate response according to API_DOC.md
			if (result && typeof result === "object") {
				// Check for valid response formats
				if (Object.hasOwn(result, "prompt") || Object.hasOwn(result, "resume")) {
					return result
				}
			}

			// Return null for invalid responses (keep polling)
			console.log("[DashboardService] Invalid polling response, continuing to poll")
			return { prompt: null, resume: false }
		} catch (error) {
			console.error("[DashboardService] Failed to poll for instructions:", error)
			throw error
		}
	}

	/**
	 * Sync local agent state changes to dashboard (for state synchronization)
	 */
	async syncAgentState(taskId: string, state: "cancelled" | "running"): Promise<any> {
		if (!this.isDashboardEnabled()) {
			return null
		}

		try {
			console.log("[DashboardService] Syncing agent state:", { taskId, state })

			// Construct the state sync endpoint URL
			let baseEndpoint = this.apiEndpoint || "https://maadhav17.pythonanywhere.com"
			baseEndpoint = baseEndpoint.replace(/\/$/, "") // Remove trailing slash
			const syncEndpoint = `${baseEndpoint}/api/agent/task/${taskId}/${state === "cancelled" ? "cancel" : "resume"}`

			console.log("[DashboardService] Syncing state to:", syncEndpoint)

			const response = await fetch(syncEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const result = await response.json()
			console.log("[DashboardService] State sync result:", result)
			return result
		} catch (error) {
			console.error("[DashboardService] Failed to sync agent state:", error)
			throw error
		}
	}

	/**
	 * Update checkpoint creation status to dashboard
	 */
	async updateCheckpointStatus(
		taskId: string,
		checkpointHash: string,
		messageTs: number,
		checkpointSummary?: string,
	): Promise<{ success: boolean; endpoint?: string; error?: string; cancel?: boolean }> {
		if (!this.isDashboardEnabled()) {
			console.log("[DashboardService] Dashboard not enabled, skipping checkpoint update")
			return { success: false, error: "Dashboard not enabled" }
		}

		try {
			console.log("[DashboardService] Updating checkpoint status:", { taskId, checkpointHash, messageTs })

			const checkpointUpdate = {
				sessionName: this.sessionName,
				timestamp: Date.now(),
				taskId: taskId,
				checkpointHash: checkpointHash,
				messageTs: messageTs,
				checkpointSummary: checkpointSummary || `Checkpoint created for task ${taskId}`,
				action: "checkpoint_created",
			}

			console.log("[DashboardService] Checkpoint update payload:", checkpointUpdate)

			// Make actual API call to dashboard
			const response = await this.makeApiCall(checkpointUpdate)

			// Check for cancel command in response (same as updateTaskState)
			const shouldCancel = response && response.cancel === true
			if (shouldCancel) {
				console.log("[DashboardService] Received cancel command from dashboard during checkpoint update")
			}

			return {
				success: true,
				endpoint: this.getApiEndpoint(),
				cancel: shouldCancel,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error("[DashboardService] Failed to update checkpoint status:", errorMessage)

			return {
				success: false,
				endpoint: this.getApiEndpoint(),
				error: errorMessage,
			}
		}
	}

	/**
	 * Check for new prompts from dashboard
	 * This will be called to get queued prompts
	 */
	async checkForPrompts(): Promise<string | null> {
		if (!this.isDashboardEnabled()) {
			return null
		}

		try {
			console.log("[DashboardService] Checking for prompts...")

			// TODO: Implement actual API call to check for prompt queue
			// For now, return null (no prompts)
			const response = await this.dummyPromptCheck()

			if (response && response.prompts && response.prompts.length > 0) {
				const nextPrompt = response.prompts[0]
				console.log("[DashboardService] Found prompt:", nextPrompt)
				return nextPrompt.prompt
			}

			return null
		} catch (error) {
			console.error("[DashboardService] Failed to check for prompts:", error)
			return null
		}
	}

	/**
	 * Report task completion to dashboard
	 */
	async reportTaskCompletion(taskSummary: any): Promise<boolean> {
		if (!this.isDashboardEnabled()) {
			return false
		}

		try {
			console.log("[DashboardService] Reporting task completion:", taskSummary)

			// TODO: Implement actual API call to report completion
			const completionReport = {
				sessionName: this.sessionName,
				timestamp: Date.now(),
				taskSummary: taskSummary,
				action: "task_completed",
			}

			await this.dummyApiCall(completionReport)
			return true
		} catch (error) {
			console.error("[DashboardService] Failed to report task completion:", error)
			return false
		}
	}

	/**
	 * Test dashboard connectivity
	 */
	async testConnection(): Promise<boolean> {
		if (!this.isDashboardEnabled()) {
			return false
		}

		try {
			console.log("[DashboardService] Testing connection...")

			// TODO: Implement actual connectivity test
			const testResult = await this.dummyConnectivityTest()

			console.log("[DashboardService] Connection test result:", testResult)
			return testResult.success
		} catch (error) {
			console.error("[DashboardService] Connection test failed:", error)
			return false
		}
	}

	/**
	 * Make actual API call to dashboard endpoint
	 */
	private async makeApiCall(data: any): Promise<any> {
		try {
			// Use configured endpoint or default to the provided URL
			const endpoint = this.apiEndpoint || "https://maadhav17.pythonanywhere.com/api/codey-checkpoint"
			console.log("[DashboardService] Making API call to:", endpoint, "with data:", data)

			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const result = await response.json()
			console.log("[DashboardService] API call successful:", result)
			return result
		} catch (error) {
			console.error("[DashboardService] API call failed:", error)
			throw error
		}
	}

	/**
	 * Dummy API call implementation (fallback)
	 * Used when API endpoint is not configured or for testing
	 */
	private async dummyApiCall(data: any): Promise<any> {
		console.log("[DashboardService] Dummy API call (fallback):", data)

		// Simulate network delay
		await new Promise((resolve) => setTimeout(resolve, 100))

		return { success: true, timestamp: Date.now() }
	}

	/**
	 * Dummy prompt check implementation
	 */
	private async dummyPromptCheck(): Promise<any> {
		console.log("[DashboardService] Dummy prompt check")

		// Simulate API delay
		await new Promise((resolve) => setTimeout(resolve, 50))

		// TODO: Replace with actual prompt queue check
		// const response = await fetch(`${this.apiEndpoint}/prompts/${this.sessionName}`)
		// return response.json()

		// Return empty queue for now
		return { prompts: [] }
	}

	/**
	 * Dummy connectivity test
	 */
	private async dummyConnectivityTest(): Promise<any> {
		console.log("[DashboardService] Dummy connectivity test")

		// Simulate network delay
		await new Promise((resolve) => setTimeout(resolve, 200))

		// TODO: Replace with actual connectivity test
		// const response = await fetch(`${this.apiEndpoint}/health`)
		// return response.json()

		return { success: true, message: "Dashboard API reachable" }
	}
}

// Global service instance
let dashboardServiceInstance: DashboardService | null = null

/**
 * Get the global dashboard service instance
 */
export function getDashboardService(): DashboardService {
	if (!dashboardServiceInstance) {
		dashboardServiceInstance = new DashboardService()
	}
	return dashboardServiceInstance
}

/**
 * Reset the dashboard service instance (useful for testing)
 */
export function resetDashboardService(): void {
	dashboardServiceInstance = null
}
