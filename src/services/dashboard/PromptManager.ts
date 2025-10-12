import { getDashboardService } from "./index"

/**
 * Prompt Manager for Dashboard Integration
 * Handles prompt queue management and injection into user input
 */
export class PromptManager {
	private isEnabled: boolean = false
	private sessionName: string = ""
	private promptQueue: string[] = []
	private isPolling: boolean = false
	private pollInterval: NodeJS.Timeout | null = null

	constructor() {
		console.log("[PromptManager] Initialized")
	}

	/**
	 * Configure the prompt manager with dashboard settings
	 */
	configure(enabled: boolean, sessionName: string): void {
		this.isEnabled = enabled
		this.sessionName = sessionName

		console.log("[PromptManager] Configured:", {
			enabled: this.isEnabled,
			sessionName: this.sessionName,
			queueLength: this.promptQueue.length,
		})

		if (this.isEnabled) {
			this.startPolling()
		} else {
			this.stopPolling()
		}
	}

	/**
	 * Start polling for new prompts from dashboard
	 */
	private startPolling(): void {
		if (this.isPolling) {
			return
		}

		this.isPolling = true
		console.log("[PromptManager] Starting prompt polling")

		// Poll every 5 seconds for new prompts
		this.pollInterval = setInterval(async () => {
			await this.checkForNewPrompts()
		}, 5000)

		// Check immediately
		this.checkForNewPrompts()
	}

	/**
	 * Stop polling for prompts
	 */
	private stopPolling(): void {
		if (!this.isPolling) {
			return
		}

		this.isPolling = false
		console.log("[PromptManager] Stopping prompt polling")

		if (this.pollInterval) {
			clearInterval(this.pollInterval)
			this.pollInterval = null
		}
	}

	/**
	 * Check for new prompts from dashboard
	 */
	private async checkForNewPrompts(): Promise<void> {
		if (!this.isEnabled || !this.sessionName) {
			return
		}

		try {
			const dashboardService = getDashboardService()
			const prompt = await dashboardService.checkForPrompts()

			if (prompt) {
				this.addPromptToQueue(prompt)
			}
		} catch (error) {
			console.error("[PromptManager] Error checking for prompts:", error)
		}
	}

	/**
	 * Add a prompt to the queue
	 */
	private addPromptToQueue(prompt: string): void {
		this.promptQueue.push(prompt)
		console.log("[PromptManager] Added prompt to queue:", {
			queueLength: this.promptQueue.length,
			prompt: prompt.substring(0, 50) + "...", // Log first 50 chars
		})
	}

	/**
	 * Get the next prompt from queue
	 */
	getNextPrompt(): string | null {
		return this.promptQueue.shift() || null
	}

	/**
	 * Check if there are prompts in queue
	 */
	hasPrompts(): boolean {
		return this.promptQueue.length > 0
	}

	/**
	 * Get current queue length
	 */
	getQueueLength(): number {
		return this.promptQueue.length
	}

	/**
	 * Clear all prompts from queue
	 */
	clearQueue(): void {
		const clearedCount = this.promptQueue.length
		this.promptQueue = []
		console.log("[PromptManager] Cleared prompt queue:", { clearedCount })
	}

	/**
	 * Get queue status
	 */
	getStatus(): {
		enabled: boolean
		sessionName: string
		queueLength: number
		isPolling: boolean
	} {
		return {
			enabled: this.isEnabled,
			sessionName: this.sessionName,
			queueLength: this.promptQueue.length,
			isPolling: this.isPolling,
		}
	}

	/**
	 * Cleanup resources
	 */
	dispose(): void {
		this.stopPolling()
		this.clearQueue()
		console.log("[PromptManager] Disposed")
	}
}

// Global prompt manager instance
let promptManagerInstance: PromptManager | null = null

/**
 * Get the global prompt manager instance
 */
export function getPromptManager(): PromptManager {
	if (!promptManagerInstance) {
		promptManagerInstance = new PromptManager()
	}
	return promptManagerInstance
}

/**
 * Reset the prompt manager instance (useful for testing)
 */
export function resetPromptManager(): void {
	if (promptManagerInstance) {
		promptManagerInstance.dispose()
	}
	promptManagerInstance = null
}
