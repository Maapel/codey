import { execa } from "execa"
import * as path from "path"
import { fileExistsAtPath } from "../../utils/fs"

export interface DashboardConfig {
	sessionName: string
	dashboardUrl?: string
	enabled: boolean
}

export interface DashboardUpdateData {
	message: string
	timestamp?: number
	metadata?: Record<string, any>
}

export interface DashboardReportData {
	summary: string
	duration?: number
	success?: boolean
	metadata?: Record<string, any>
}

/**
 * Service for handling dashboard integration functionality
 */
export class DashboardService {
	private config: DashboardConfig | null = null
	private workspaceRoot: string

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
	}

	/**
	 * Update dashboard configuration
	 */
	updateConfig(config: DashboardConfig): void {
		this.config = config
	}

	/**
	 * Check if dashboard integration is enabled
	 */
	isEnabled(): boolean {
		return this.config?.enabled ?? false
	}

	/**
	 * Sleep utility function for adding delays
	 */
	private async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * Send progress update to dashboard via update.sh script
	 */
	async sendUpdate(data: DashboardUpdateData): Promise<boolean> {
		if (!this.isEnabled() || !this.config) {
			return false
		}

		try {
			const updateScriptPath = path.join(this.workspaceRoot, "update.sh")

			// Check if update.sh exists using the proper utility
			const scriptExists = await fileExistsAtPath(updateScriptPath)

			if (!scriptExists) {
				console.warn(`Dashboard update script not found at: ${updateScriptPath}`)
				return false
			}

			// Prepare the message with session name
			const message = JSON.stringify({
				sessionName: this.config.sessionName,
				message: data.message,
				timestamp: data.timestamp || Date.now(),
				metadata: data.metadata || {},
			})

			// Add small delay before executing command
			await this.sleep(100)

			// Execute update.sh script with the message
			const result = await execa("bash", [updateScriptPath, this.config.sessionName, message], {
				cwd: this.workspaceRoot,
				timeout: 10000, // 10 second timeout
			})

			console.log(`Dashboard update sent successfully: ${result.stdout}`)
			return true
		} catch (error) {
			console.error("Failed to send dashboard update:", error)
			return false
		}
	}

	/**
	 * Send task completion report to dashboard via report_and_fetch.sh script
	 */
	async sendReport(data: DashboardReportData): Promise<boolean> {
		if (!this.isEnabled() || !this.config) {
			return false
		}

		try {
			const reportScriptPath = path.join(this.workspaceRoot, "report_and_fetch.sh")

			// Check if report_and_fetch.sh exists using the proper utility
			const scriptExists = await fileExistsAtPath(reportScriptPath)

			if (!scriptExists) {
				console.warn(`Dashboard report script not found at: ${reportScriptPath}`)
				return false
			}

			// Prepare the report data with session name
			const reportData = JSON.stringify({
				sessionName: this.config.sessionName,
				summary: data.summary,
				duration: data.duration,
				success: data.success ?? true,
				timestamp: Date.now(),
				metadata: data.metadata || {},
			})

			// Add small delay before executing command
			await this.sleep(150)

			// Execute report_and_fetch.sh script with the report data
			const result = await execa("bash", [reportScriptPath, this.config.sessionName, reportData], {
				cwd: this.workspaceRoot,
				timeout: 15000, // 15 second timeout for reports
			})

			console.log(`Dashboard report sent successfully: ${result.stdout}`)
			return true
		} catch (error) {
			console.error("Failed to send dashboard report:", error)
			return false
		}
	}

	/**
	 * Test dashboard connectivity by sending a test update
	 */
	async testConnection(): Promise<boolean> {
		if (!this.isEnabled() || !this.config) {
			return false
		}

		return await this.sendUpdate({
			message: "Dashboard integration test from Codey",
			timestamp: Date.now(),
			metadata: { test: true },
		})
	}
}

// Create a singleton instance for easy access throughout the application
let _dashboardServiceInstance: DashboardService | null = null

/**
 * Get the singleton dashboard service instance
 * @param workspaceRoot The workspace root path
 * @returns DashboardService instance
 */
export function getDashboardService(workspaceRoot?: string): DashboardService {
	if (!_dashboardServiceInstance) {
		if (!workspaceRoot) {
			throw new Error("workspaceRoot is required when creating the first DashboardService instance")
		}
		_dashboardServiceInstance = new DashboardService(workspaceRoot)
	}
	return _dashboardServiceInstance
}

/**
 * Reset the dashboard service instance (useful for testing)
 */
export function resetDashboardService(): void {
	_dashboardServiceInstance = null
}

export const dashboardService = new Proxy({} as DashboardService, {
	get(_target, prop, _receiver) {
		// Return a function that will call the method on the actual service
		return async (...args: any[]) => {
			const service: DashboardService = getDashboardService()
			const method = Reflect.get(service, prop, service)
			if (typeof method === "function") {
				return method.apply(service, args)
			}
			return method
		}
	},
})
