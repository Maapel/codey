import * as vscode from "vscode"
import {
	migrateCustomInstructionsToGlobalRules,
	migrateTaskHistoryToFile,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { WebviewProvider } from "./core/webview"
import { Logger } from "./services/logging/Logger"
import "./utils/path" // necessary to have access to String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider"
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker"
import { StateManager } from "./core/storage/StateManager"
import { ExtensionRegistryInfo } from "./registry"
import { audioRecordingService } from "./services/dictation/AudioRecordingService"
import { ErrorService } from "./services/error"
import { featureFlagsService } from "./services/feature-flags"
import { initializeDistinctId } from "./services/logging/distinctId"
import { telemetryService } from "./services/telemetry"
import { PostHogClientProvider } from "./services/telemetry/providers/posthog/PostHogClientProvider"
import { ShowMessageType } from "./shared/proto/host/window"
import { getLatestAnnouncementId } from "./utils/announcements"
/**
 * Performs intialization for Cline that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 */
export async function initialize(context: vscode.ExtensionContext): Promise<WebviewProvider> {
	try {
		await StateManager.initialize(context)
	} catch (error) {
		console.error("[Controller] CRITICAL: Failed to initialize StateManager - extension may not function properly:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to initialize Cline's application state. Please restart the extension.",
		})
	}

	// Set the distinct ID for logging and telemetry
	await initializeDistinctId(context)

	// Initialize PostHog client provider
	PostHogClientProvider.getInstance()

	// Setup the external services
	await ErrorService.initialize()
	await featureFlagsService.poll()

	// Migrate custom instructions to global Cline rules (one-time cleanup)
	await migrateCustomInstructionsToGlobalRules(context)

	// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
	await migrateWelcomeViewCompleted(context)

	// Migrate workspace storage values back to global storage (reverting previous migration)
	await migrateWorkspaceToGlobalStorage(context)

	// Ensure taskHistory.json exists and migrate legacy state (runs once)
	await migrateTaskHistoryToFile(context)

	// Clean up orphaned file context warnings (startup cleanup)
	await FileContextTracker.cleanupOrphanedWarnings(context)

	// Initialize dashboard integration manager with current settings
	try {
		const { getDashboardIntegrationManager } = require("@services/dashboard/DashboardIntegrationManager")
		const dashboardManager = getDashboardIntegrationManager()
		const dashboardSettings = context.globalState.get("dashboardSettings") as any

		const statusBefore = dashboardManager.getStatus()
		const settingsInfo = dashboardSettings
			? `enabled: ${dashboardSettings.enabled}, session: ${dashboardSettings.sessionName || "none"}, url: ${dashboardSettings.dashboardUrl || "none"}`
			: "no settings found"

		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `🔧 Dashboard Init Debug:\n• Settings: ${settingsInfo}\n• Manager initialized: ${statusBefore.initialized}`,
		})

		// Always initialize with current settings, regardless of enabled state
		if (dashboardSettings) {
			console.log("[Common] Initializing dashboard with settings:", dashboardSettings)
			dashboardManager.initialize(dashboardSettings)
			const statusAfter = dashboardManager.getStatus()

			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `✅ Dashboard initialized!\n• Manager: ${statusAfter.initialized ? "YES" : "NO"}\n• Service enabled: ${statusAfter.dashboardService?.enabled ? "YES" : "NO"}\n• Endpoint: ${statusAfter.dashboardService?.endpoint || "none"}`,
			})
		} else {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `ℹ️ Dashboard initialization skipped: ${settingsInfo}`,
			})
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error"
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `❌ Dashboard initialization failed: ${errorMessage}`,
		})
	}

	const webview = HostProvider.get().createWebviewProvider()

	await showVersionUpdateAnnouncement(context)

	telemetryService.captureExtensionActivated()

	return webview
}

async function showVersionUpdateAnnouncement(context: vscode.ExtensionContext) {
	// Version checking for autoupdate notification
	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = context.globalState.get<string>("clineVersion")
	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`Cline version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Use the same condition as announcements: focus when there's a new announcement to show
			const lastShownAnnouncementId = context.globalState.get<string>("lastShownAnnouncementId")
			const latestAnnouncementId = getLatestAnnouncementId()

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Focus Cline when there's a new announcement to show (major/minor updates or fresh installs)
				const message = previousVersion
					? `Cline has been updated to v${currentVersion}`
					: `Welcome to Cline v${currentVersion}`
				await HostProvider.workspace.openClineSidebarPanel({})
				await new Promise((resolve) => setTimeout(resolve, 200))
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message,
				})
			}
			// Always update the main version tracker for the next launch.
			await context.globalState.update("clineVersion", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error(`Error during post-update actions: ${errorMessage}, Stack trace: ${error.stack}`)
	}
}

/**
 * Performs cleanup when Cline is deactivated that is common to all platforms.
 */
export async function tearDown(): Promise<void> {
	// Clean up audio recording service to ensure no orphaned processes
	audioRecordingService.cleanup()

	PostHogClientProvider.getInstance().dispose()
	telemetryService.dispose()
	ErrorService.get().dispose()
	featureFlagsService.dispose()
	// Dispose all webview instances
	await WebviewProvider.disposeAllInstances()
}
