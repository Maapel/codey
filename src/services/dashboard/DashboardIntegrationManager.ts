import { DashboardSettings } from "@shared/DashboardSettings"
import { getDashboardService } from "./index"
import { getPromptManager, PromptManager } from "./PromptManager"
import { getStateTracker, StateTracker } from "./StateTracker"

/**
 * Dashboard Integration Manager
 * Coordinates all dashboard-related functionality and manages the complete integration
 */
export class DashboardIntegrationManager {
	private stateTracker: StateTracker
	private promptManager: PromptManager
	private dashboardService = getDashboardService()
	private isInitialized: boolean = false

	constructor() {
		this.stateTracker = getStateTracker()
		this.promptManager = getPromptManager()
		console.log("[DashboardIntegrationManager] Constructor called - new instance created")
	}

	/**
	 * Initialize the dashboard integration with user settings
	 */
	initialize(settings: DashboardSettings): void {
		console.log("[DashboardIntegrationManager] Initializing with settings:", settings)

		// Configure all services with the new settings
		this.dashboardService.configure(settings)
		this.stateTracker.configure(settings.enabled, settings.sessionName)
		this.promptManager.configure(settings.enabled, settings.sessionName)

		this.isInitialized = true

		console.log("[DashboardIntegrationManager] Initialization complete")
	}

	/**
	 * Update configuration when settings change
	 */
	updateConfiguration(settings: DashboardSettings): void {
		try {
			console.log("[DashboardIntegrationManager] Updating configuration:", settings)

			// If dashboard is being disabled, mark as not initialized
			if (!settings.enabled) {
				this.isInitialized = false
				console.log("[DashboardIntegrationManager] Dashboard disabled, marking as not initialized")
			}

			// Reconfigure all services
			this.dashboardService.configure(settings)
			this.stateTracker.configure(settings.enabled, settings.sessionName)
			this.promptManager.configure(settings.enabled, settings.sessionName)

			// If dashboard is being enabled, mark as initialized
			if (settings.enabled) {
				this.isInitialized = true
				console.log("[DashboardIntegrationManager] Dashboard enabled, marking as initialized")
			}

			console.log("[DashboardIntegrationManager] Configuration updated successfully")
		} catch (error) {
			console.error("[DashboardIntegrationManager] Failed to update configuration:", error)
			// Don't throw error to prevent breaking the settings UI
		}
	}

	/**
	 * Track task start
	 */
	trackTaskStart(taskId: string, taskDescription: string): void {
		if (!this.isInitialized) {
			console.warn("[DashboardIntegrationManager] Not initialized, skipping task tracking")
			return
		}

		this.stateTracker.trackTaskStart(taskId, taskDescription)
	}

	/**
	 * Track AI API call
	 */
	trackApiCall(request: any, response?: any): void {
		if (!this.isInitialized) {
			return
		}

		this.stateTracker.trackApiCall(request, response)
	}

	/**
	 * Track task completion
	 */
	trackTaskCompletion(taskSummary: any): void {
		if (!this.isInitialized) {
			return
		}

		this.stateTracker.trackTaskCompletion(taskSummary)
	}

	/**
	 * Track progress update
	 */
	trackProgressUpdate(progress: number, currentStep: string): void {
		if (!this.isInitialized) {
			return
		}

		this.stateTracker.trackProgressUpdate(progress, currentStep)
	}

	/**
	 * Track checkpoint creation
	 */
	async trackCheckpointCreation(
		taskId: string,
		checkpointHash: string,
		messageTs: number,
		checkpointSummary?: string,
	): Promise<{ success: boolean; endpoint?: string; error?: string }> {
		if (!this.isInitialized) {
			return { success: false, error: "Dashboard integration manager not initialized" }
		}

		return await this.dashboardService.updateCheckpointStatus(taskId, checkpointHash, messageTs, checkpointSummary)
	}

	/**
	 * Check for available prompts
	 */
	checkForPrompts(): string | null {
		if (!this.isInitialized) {
			return null
		}

		return this.promptManager.getNextPrompt()
	}

	/**
	 * Check if prompts are available
	 */
	hasPrompts(): boolean {
		return this.promptManager.hasPrompts()
	}

	/**
	 * Get current status of all services
	 */
	getStatus(): {
		initialized: boolean
		dashboardService: any
		stateTracker: any
		promptManager: any
	} {
		return {
			initialized: this.isInitialized,
			dashboardService: {
				enabled: this.dashboardService.isDashboardEnabled(),
				endpoint: this.dashboardService.getApiEndpoint(),
				sessionName: this.dashboardService.getSessionName(),
			},
			stateTracker: this.stateTracker.getStatus(),
			promptManager: this.promptManager.getStatus(),
		}
	}

	/**
	 * Test dashboard connectivity
	 */
	async testConnection(): Promise<boolean> {
		if (!this.isInitialized) {
			return false
		}

		return await this.dashboardService.testConnection()
	}

	/**
	 * Cleanup and dispose all services
	 */
	dispose(): void {
		console.log("[DashboardIntegrationManager] Disposing...")

		this.promptManager.dispose()
		// Note: StateTracker and DashboardService don't have dispose methods yet
		// but they could be added if needed for cleanup

		this.isInitialized = false
		console.log("[DashboardIntegrationManager] Disposed")
	}
}

// Global integration manager instance
let integrationManagerInstance: DashboardIntegrationManager | null = null

/**
 * Get the global dashboard integration manager instance
 */
export function getDashboardIntegrationManager(): DashboardIntegrationManager {
	if (!integrationManagerInstance) {
		console.log("[DashboardIntegrationManager] Creating new instance")
		integrationManagerInstance = new DashboardIntegrationManager()
	} else {
		console.log("[DashboardIntegrationManager] Returning existing instance")
	}
	return integrationManagerInstance
}

/**
 * Reset the integration manager instance (useful for testing)
 */
export function resetDashboardIntegrationManager(): void {
	if (integrationManagerInstance) {
		integrationManagerInstance.dispose()
	}
	integrationManagerInstance = null
}
