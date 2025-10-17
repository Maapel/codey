import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "@core/api"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { ensureTaskDirectoryExists } from "@core/storage/disk"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { findLast, findLastIndex } from "@shared/array"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { ClineApiReqInfo, ClineMessage, ClineSay } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { ClineCheckpointRestore } from "@shared/WebviewMessage"
import pTimeout from "p-timeout"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { MessageStateHandler } from "../../core/task/message-state"
import { TaskState } from "../../core/task/TaskState"
import { getDashboardIntegrationManager } from "../../services/dashboard/DashboardIntegrationManager"
import { ICheckpointManager } from "./types"

// Type definitions for better code organization
type SayFunction = (
	type: ClineSay,
	text?: string,
	images?: string[],
	files?: string[],
	partial?: boolean,
) => Promise<number | undefined>
type UpdateTaskHistoryFunction = (historyItem: HistoryItem) => Promise<HistoryItem[]>

interface CheckpointManagerTask {
	readonly taskId: string
}
interface CheckpointManagerConfig {
	readonly enableCheckpoints: boolean
}
interface CheckpointManagerServices {
	readonly fileContextTracker: FileContextTracker
	readonly diffViewProvider: DiffViewProvider
	readonly messageStateHandler: MessageStateHandler
	readonly taskState: TaskState
	readonly workspaceManager?: WorkspaceRootManager
	readonly api?: ApiHandler
}
interface CheckpointManagerCallbacks {
	readonly updateTaskHistory: UpdateTaskHistoryFunction
	readonly cancelTask: () => Promise<void>
	readonly say: SayFunction
	readonly postStateToWebview: () => Promise<void>
}
interface CheckpointManagerInternalState {
	conversationHistoryDeletedRange?: [number, number]
	checkpointTracker?: CheckpointTracker
	checkpointManagerErrorMessage?: string
	checkpointTrackerInitPromise?: Promise<CheckpointTracker | undefined>
}

interface CheckpointRestoreStateUpdate {
	conversationHistoryDeletedRange?: [number, number]
	checkpointManagerErrorMessage?: string
}

/**
 * TaskCheckpointManager
 *
 * A dedicated service for managing all checkpoint-related operations within a task.
 * Provides a clean separation of concerns from the main Task class while maintaining
 * full access to necessary dependencies and state.
 *
 * Public API:
 * - saveCheckpoint: Creates a new checkpoint of the current workspace state
 * - restoreCheckpoint: Restores the task to a previous checkpoint
 * - presentMultifileDiff: Displays a multi-file diff view between checkpoints
 * - doesLatestTaskCompletionHaveNewChanges: Checks if the latest task completion has new changes, used by the "See New Changes" button
 *
 * This class is designed as the main interface between the task and the checkpoint system. It is responsible for:
 * - Task-specific checkpoint operations (save/restore/diff)
 * - State management and coordination with other Task components
 * - Interaction with message state, file context tracking etc.
 * - User interaction (error messages, notifications)
 *
 * For checkpoint operations, the CheckpointTracker class is used to interact with the underlying git logic.
 */
export class TaskCheckpointManager implements ICheckpointManager {
	private readonly task: CheckpointManagerTask
	private readonly config: CheckpointManagerConfig
	private readonly services: CheckpointManagerServices
	private readonly callbacks: CheckpointManagerCallbacks
	private readonly taskState: TaskState

	private state: CheckpointManagerInternalState

	constructor(
		task: CheckpointManagerTask,
		config: CheckpointManagerConfig,
		services: CheckpointManagerServices,
		callbacks: CheckpointManagerCallbacks,
		initialState: CheckpointManagerInternalState,
	) {
		this.task = Object.freeze(task)
		this.config = config
		this.services = services
		this.callbacks = Object.freeze(callbacks)
		this.taskState = services.taskState
		this.state = { ...initialState }
	}

	// ============================================================================
	// Public API - Core checkpoints operations
	// ============================================================================

	/**
	 * Creates a checkpoint of the current workspace state
	 * @param isAttemptCompletionMessage - Whether this checkpoint is for an attempt completion message
	 * @param completionMessageTs - Optional timestamp of the completion message to update with checkpoint hash
	 * @param checkpointSummary - Optional summary of what was accomplished in this checkpoint
	 */
	async saveCheckpoint(
		isAttemptCompletionMessage: boolean = false,
		completionMessageTs?: number,
		checkpointSummary?: string,
	): Promise<void> {
		try {
			// If checkpoints are disabled or previously encountered a timeout error, return early
			if (
				!this.config.enableCheckpoints ||
				this.state.checkpointManagerErrorMessage?.includes("Checkpoints initialization timed out.")
			) {
				return
			}

			// Set isCheckpointCheckedOut to false for all prior checkpoint_created messages
			const clineMessages = this.services.messageStateHandler.getClineMessages()
			clineMessages.forEach((message) => {
				if (message.say === "checkpoint_created") {
					message.isCheckpointCheckedOut = false
				}
			})

			// Prevent repetitive checkpointTracker initialization errors on non-attempt completion messages
			if (!this.state.checkpointTracker && !isAttemptCompletionMessage && !this.state.checkpointManagerErrorMessage) {
				await this.checkpointTrackerCheckAndInit()
			}
			// attempt completion messages give it one last chance. Skip if there was a previous checkpoints initialization timeout error.
			else if (
				!this.state.checkpointTracker &&
				isAttemptCompletionMessage &&
				!this.state.checkpointManagerErrorMessage?.includes("Checkpoints initialization timed out.")
			) {
				await this.checkpointTrackerCheckAndInit()
			}

			// Critical failure to initialize checkpoint tracker, return early
			if (!this.state.checkpointTracker) {
				console.error(
					`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}: Checkpoint tracker not available`,
				)
				return
			}

			// Non attempt-completion messages call for a checkpoint_created message to be added
			if (!isAttemptCompletionMessage) {
				// Ensure we aren't creating back-to-back checkpoint_created messages
				const lastMessage = clineMessages.at(-1)
				if (lastMessage?.say === "checkpoint_created") {
					return
				}

				// Create a new checkpoint_created message and asynchronously add the commitHash to the say message
				const messageTs = await this.callbacks.say("checkpoint_created")
				if (messageTs) {
					const messages = this.services.messageStateHandler.getClineMessages()
					const targetMessage = messages.find((m) => m.ts === messageTs)

					if (targetMessage) {
						this.state.checkpointTracker
							?.commit()
							.then(async (commitHash) => {
								if (commitHash) {
									targetMessage.lastCheckpointHash = commitHash

									// Check if dashboard is enabled and generate checkpoint summary if needed
									const dashboardManager = getDashboardIntegrationManager()
									const dashboardStatus = dashboardManager.getStatus()
									const isDashboardEnabled =
										dashboardStatus.initialized && dashboardStatus.dashboardService?.enabled === true

									if (isDashboardEnabled && !targetMessage.checkpointSummary) {
										// Generate a summary based on recent messages
										const recentMessages = messages.slice(-10) // Look at last 10 messages
										const summary = await this.generateCheckpointSummary(recentMessages)
										targetMessage.checkpointSummary = summary

										// Debug: Show recent messages and generated summary
										const debugMessages = recentMessages
											.map((m) => `${m.say}: ${m.text?.substring(0, 50) || "no text"}`)
											.join("\n")
										HostProvider.window.showMessage({
											type: ShowMessageType.INFORMATION,
											message: `🔍 DEBUG Recent Messages:\n${debugMessages}\n\n📋 Generated Summary: "${summary}"`,
										})
									}

									await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

									// Update dashboard with checkpoint creation (only if enabled)
									console.log(`[TaskCheckpointManager] Dashboard check:`, {
										initialized: dashboardStatus.initialized,
										enabled: isDashboardEnabled,
										endpoint: dashboardStatus.dashboardService?.endpoint,
										sessionName: dashboardStatus.dashboardService?.sessionName,
									})

									if (isDashboardEnabled) {
										console.log(
											`[TaskCheckpointManager] Updating dashboard for checkpoint creation: taskId=${this.task.taskId}, commitHash=${commitHash}, messageTs=${messageTs}, summary=${targetMessage.checkpointSummary}`,
										)
										HostProvider.window.showMessage({
											type: ShowMessageType.INFORMATION,
											message: "Updating dashboard with checkpoint creation...",
										})
										try {
											// Call the new checkpoint-specific API method with enhanced return type
											const apiResult = await dashboardManager.trackCheckpointCreation(
												this.task.taskId,
												commitHash,
												messageTs,
												targetMessage.checkpointSummary,
											)

											// Only set dashboard update status if the update actually happened
											targetMessage.dashboardUpdateStatus = true
											await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

											if (apiResult.success) {
												// Show success message with API call details
												HostProvider.window.showMessage({
													type: ShowMessageType.INFORMATION,
													message: `✅ Dashboard API call successful!

📍 Endpoint: ${apiResult.endpoint}
🔖 Checkpoint: ${commitHash}
📋 Summary: ${targetMessage.checkpointSummary || "Checkpoint created"}`,
												})
											} else {
												// Show API disabled message
												HostProvider.window.showMessage({
													type: ShowMessageType.INFORMATION,
													message: `ℹ️ Dashboard update skipped: ${apiResult.error}`,
												})
											}
										} catch (error) {
											const errorMessage = error instanceof Error ? error.message : "Unknown error"
											console.error(
												`[TaskCheckpointManager] Dashboard update failed for checkpoint: ${commitHash}:`,
												errorMessage,
											)

											// Show detailed error message with API call feedback
											const dashboardService = dashboardManager.getStatus().dashboardService
											const endpoint = dashboardService?.getApiEndpoint
												? dashboardService.getApiEndpoint()
												: "Unknown endpoint"

											HostProvider.window.showMessage({
												type: ShowMessageType.ERROR,
												message: `❌ Dashboard API call failed!

🔴 Error: ${errorMessage}
📍 Endpoint: ${endpoint}
🔖 Checkpoint: ${commitHash}`,
											})
										}
									} else {
										console.log(
											`[TaskCheckpointManager] Dashboard not enabled or not initialized, skipping checkpoint update`,
										)
									}
								}
							})
							.catch((error) => {
								console.error(
									`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`,
									error,
								)
							})
					}
				}
			} else {
				// attempt_completion messages are special
				// First check last 3 messages to see if we already have a recent completion checkpoint
				// If we do, skip creating a duplicate checkpoint
				const lastFiveclineMessages = this.services.messageStateHandler.getClineMessages().slice(-3)
				const lastCompletionResultMessage = findLast(lastFiveclineMessages, (m) => m.say === "completion_result")
				if (lastCompletionResultMessage?.lastCheckpointHash) {
					console.log("Completion checkpoint already exists, skipping duplicate checkpoint creation")
					return
				}

				// For attempt_completion, commit then update the completion_result message with the checkpoint hash
				if (this.state.checkpointTracker) {
					const commitHash = await this.state.checkpointTracker.commit()

					// Generate a summary for the attempt completion if not provided
					let finalCheckpointSummary = checkpointSummary
					if (!finalCheckpointSummary) {
						const recentMessages = this.services.messageStateHandler.getClineMessages().slice(-10)
						finalCheckpointSummary = await this.generateCheckpointSummary(recentMessages)
					}

					// If a completionMessageTs is provided, update that specific message with the checkpoint hash
					if (completionMessageTs) {
						const targetMessage = this.services.messageStateHandler
							.getClineMessages()
							.find((m) => m.ts === completionMessageTs)
						if (targetMessage) {
							targetMessage.lastCheckpointHash = commitHash
							// Store the checkpoint summary
							targetMessage.checkpointSummary = finalCheckpointSummary
							await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

							// Update dashboard with attempt completion checkpoint (only if enabled)
							const dashboardManager = getDashboardIntegrationManager()
							const dashboardStatus = dashboardManager.getStatus()

							console.log(`[TaskCheckpointManager] Dashboard check for attempt completion:`, {
								initialized: dashboardStatus.initialized,
								dashboardServiceEnabled: dashboardStatus.dashboardService?.enabled,
								endpoint: dashboardStatus.dashboardService?.endpoint,
								sessionName: dashboardStatus.dashboardService?.sessionName,
							})

							if (dashboardStatus.initialized && dashboardStatus.dashboardService?.enabled === true) {
								console.log(
									`[TaskCheckpointManager] Updating dashboard for attempt completion checkpoint: taskId=${this.task.taskId}, commitHash=${commitHash}, messageTs=${completionMessageTs}, summary=${finalCheckpointSummary}`,
								)
								HostProvider.window.showMessage({
									type: ShowMessageType.INFORMATION,
									message: "Updating dashboard with attempt completion checkpoint...",
								})
								try {
									// Call the checkpoint-specific API method with enhanced return type
									if (commitHash) {
										const apiResult = await dashboardManager.trackCheckpointCreation(
											this.task.taskId,
											commitHash,
											completionMessageTs ||
												(lastCompletionResultMessage ? lastCompletionResultMessage.ts : Date.now()),
											finalCheckpointSummary,
										)

										// Only set dashboard update status if the update actually happened
										targetMessage.dashboardUpdateStatus = true
										await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

										if (apiResult.success) {
											// Show success message with API call details
											HostProvider.window.showMessage({
												type: ShowMessageType.INFORMATION,
												message: `✅ Dashboard API call successful!

📍 Endpoint: ${apiResult.endpoint}
🔖 Checkpoint: ${commitHash}
📋 Summary: ${finalCheckpointSummary || "Task completed"}`,
											})
										} else {
											// Show API disabled message
											HostProvider.window.showMessage({
												type: ShowMessageType.INFORMATION,
												message: `ℹ️ Dashboard update skipped: ${apiResult.error}`,
											})
										}
									}
								} catch (error) {
									const errorMessage = error instanceof Error ? error.message : "Unknown error"
									console.error(
										`[TaskCheckpointManager] Dashboard update failed for attempt completion checkpoint: ${commitHash}:`,
										errorMessage,
									)

									// Show detailed error message with API call feedback
									const dashboardService = dashboardManager.getStatus().dashboardService
									const endpoint = dashboardService?.getApiEndpoint
										? dashboardService.getApiEndpoint()
										: "Unknown endpoint"

									HostProvider.window.showMessage({
										type: ShowMessageType.ERROR,
										message: `❌ Dashboard API call failed!

🔴 Error: ${errorMessage}
📍 Endpoint: ${endpoint}
🔖 Checkpoint: ${commitHash}`,
									})
								}
							} else {
								console.log(
									`[TaskCheckpointManager] Dashboard not enabled or not initialized, skipping attempt completion checkpoint update`,
								)
							}
						}
					} else {
						// Fallback to findLast if no timestamp provided - update the last completion_result message
						if (lastCompletionResultMessage) {
							lastCompletionResultMessage.lastCheckpointHash = commitHash
							// Store the checkpoint summary
							lastCompletionResultMessage.checkpointSummary = finalCheckpointSummary
							await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

							// Update dashboard with attempt completion checkpoint (only if enabled)
							const dashboardManager = getDashboardIntegrationManager()
							const dashboardStatus = dashboardManager.getStatus()

							console.log(`[TaskCheckpointManager] Dashboard check for attempt completion (fallback):`, {
								initialized: dashboardStatus.initialized,
								dashboardServiceEnabled: dashboardStatus.dashboardService?.enabled,
								endpoint: dashboardStatus.dashboardService?.endpoint,
								sessionName: dashboardStatus.dashboardService?.sessionName,
							})

							if (dashboardStatus.initialized && dashboardStatus.dashboardService?.enabled === true) {
								console.log(
									`[TaskCheckpointManager] Updating dashboard for attempt completion checkpoint (fallback): taskId=${this.task.taskId}, commitHash=${commitHash}, messageTs=${lastCompletionResultMessage.ts}, summary=${finalCheckpointSummary}`,
								)
								HostProvider.window.showMessage({
									type: ShowMessageType.INFORMATION,
									message: "Updating dashboard with attempt completion checkpoint...",
								})
								try {
									// Call the checkpoint-specific API method with enhanced return type
									if (commitHash && lastCompletionResultMessage) {
										const apiResult = await dashboardManager.trackCheckpointCreation(
											this.task.taskId,
											commitHash,
											lastCompletionResultMessage.ts,
											finalCheckpointSummary,
										)

										// Only set dashboard update status if the update actually happened
										lastCompletionResultMessage.dashboardUpdateStatus = true
										await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

										if (apiResult.success) {
											// Show success message with API call details
											HostProvider.window.showMessage({
												type: ShowMessageType.INFORMATION,
												message: `✅ Dashboard API call successful!

📍 Endpoint: ${apiResult.endpoint}
🔖 Checkpoint: ${commitHash}
📋 Summary: ${finalCheckpointSummary || "Task completed"}`,
											})
										} else {
											// Show API disabled message
											HostProvider.window.showMessage({
												type: ShowMessageType.INFORMATION,
												message: `ℹ️ Dashboard update skipped: ${apiResult.error}`,
											})
										}
									}
								} catch (error) {
									const errorMessage = error instanceof Error ? error.message : "Unknown error"
									console.error(
										`[TaskCheckpointManager] Dashboard update failed for attempt completion checkpoint (fallback): ${commitHash}:`,
										errorMessage,
									)

									// Show detailed error message with API call feedback
									const dashboardService = dashboardManager.getStatus().dashboardService
									const endpoint = dashboardService?.getApiEndpoint
										? dashboardService.getApiEndpoint()
										: "Unknown endpoint"

									HostProvider.window.showMessage({
										type: ShowMessageType.ERROR,
										message: `❌ Dashboard API call failed!

🔴 Error: ${errorMessage}
📍 Endpoint: ${endpoint}
🔖 Checkpoint: ${commitHash}`,
									})
								}
							} else {
								console.log(
									`[TaskCheckpointManager] Dashboard not enabled or not initialized, skipping attempt completion checkpoint update (fallback)`,
								)
							}
						}
					}
				} else {
					console.error(
						`[TaskCheckpointManager] Checkpoint tracker does not exist and could not be initialized for attempt completion for task ${this.task.taskId}`,
					)
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error(`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}:`, errorMessage)
		}
	}

	/**
	 * Restores a checkpoint by message timestamp
	 * @param messageTs - Timestamp of the message to restore to
	 * @param restoreType - Type of restoration (task, workspace, or both)
	 * @param offset - Optional offset for the message index
	 * @returns checkpointManagerStateUpdate with any state changes that need to be applied
	 */
	async restoreCheckpoint(
		messageTs: number,
		restoreType: ClineCheckpointRestore,
		offset?: number,
	): Promise<CheckpointRestoreStateUpdate> {
		try {
			const clineMessages = this.services.messageStateHandler.getClineMessages()
			const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs) - (offset || 0)
			// Find the last message before messageIndex that has a lastCheckpointHash
			const lastHashIndex = findLastIndex(clineMessages.slice(0, messageIndex), (m) => m.lastCheckpointHash !== undefined)
			const message = clineMessages[messageIndex]
			const lastMessageWithHash = clineMessages[lastHashIndex]

			if (!message) {
				console.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
				return {}
			}

			let didWorkspaceRestoreFail = false

			switch (restoreType) {
				case "task":
					break
				case "taskAndWorkspace":
				case "workspace":
					if (!this.config.enableCheckpoints) {
						const errorMessage = "Checkpoints are disabled in settings."
						console.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
						HostProvider.window.showMessage({
							type: ShowMessageType.ERROR,
							message: errorMessage,
						})
						didWorkspaceRestoreFail = true
						break
					}

					if (!this.state.checkpointTracker && !this.state.checkpointManagerErrorMessage) {
						try {
							const workspacePath = await this.getWorkspacePath()
							this.state.checkpointTracker = await CheckpointTracker.create(
								this.task.taskId,
								this.config.enableCheckpoints,
								workspacePath,
							)
							this.services.messageStateHandler.setCheckpointTracker(this.state.checkpointTracker)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							console.error(
								`[TaskCheckpointManager] Failed to initialize checkpoint tracker for task ${this.task.taskId}:`,
								errorMessage,
							)
							this.state.checkpointManagerErrorMessage = errorMessage
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: errorMessage,
							})
							didWorkspaceRestoreFail = true
						}
					}
					if (message.lastCheckpointHash && this.state.checkpointTracker) {
						try {
							await this.state.checkpointTracker.resetHead(message.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							console.error(
								`[TaskCheckpointManager] Failed to restore checkpoint for task ${this.task.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: "Failed to restore checkpoint: " + errorMessage,
							})
							didWorkspaceRestoreFail = true
						}
					} else if (offset && lastMessageWithHash.lastCheckpointHash && this.state.checkpointTracker) {
						try {
							await this.state.checkpointTracker.resetHead(lastMessageWithHash.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							console.error(
								`[TaskCheckpointManager] Failed to restore offset checkpoint for task ${this.task.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: "Failed to restore offset checkpoint: " + errorMessage,
							})
							didWorkspaceRestoreFail = true
						}
					} else if (!offset && lastMessageWithHash.lastCheckpointHash && this.state.checkpointTracker) {
						// Fallback: restore to most recent checkpoint when target message has no checkpoint hash
						console.warn(
							`[TaskCheckpointManager] Message ${messageTs} has no checkpoint hash, falling back to previous checkpoint for task ${this.task.taskId}`,
						)
						try {
							await this.state.checkpointTracker.resetHead(lastMessageWithHash.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							console.error(
								`[TaskCheckpointManager] Failed to restore fallback checkpoint for task ${this.task.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: "Failed to restore checkpoint: " + errorMessage,
							})
							didWorkspaceRestoreFail = true
						}
					} else {
						const errorMessage = "Failed to restore checkpoint: No valid checkpoint hash found"
						console.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
						HostProvider.window.showMessage({
							type: ShowMessageType.ERROR,
							message: errorMessage,
						})
						didWorkspaceRestoreFail = true
					}
					break
			}

			const checkpointManagerStateUpdate: CheckpointRestoreStateUpdate = {}

			if (!didWorkspaceRestoreFail) {
				await this.handleSuccessfulRestore(restoreType, message, messageIndex, messageTs)

				// Collect state updates
				if (this.state.conversationHistoryDeletedRange !== undefined) {
					checkpointManagerStateUpdate.conversationHistoryDeletedRange = this.state.conversationHistoryDeletedRange
				}
			} else {
				sendRelinquishControlEvent()

				if (this.state.checkpointManagerErrorMessage !== undefined) {
					checkpointManagerStateUpdate.checkpointManagerErrorMessage = this.state.checkpointManagerErrorMessage
				}
			}

			return checkpointManagerStateUpdate
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error(`[TaskCheckpointManager] Failed to restore checkpoint for task ${this.task.taskId}:`, errorMessage)
			sendRelinquishControlEvent()
			return {
				checkpointManagerErrorMessage: errorMessage,
			}
		}
	}

	/**
	 * Presents a multi-file diff view between checkpoints
	 * @param messageTs - Timestamp of the message to show diff for
	 * @param seeNewChangesSinceLastTaskCompletion - Whether to show changes since last completion
	 */
	async presentMultifileDiff(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void> {
		const relinquishButton = () => {
			sendRelinquishControlEvent()
		}

		try {
			if (!this.config.enableCheckpoints) {
				const errorMessage = "Checkpoints are disabled in settings. Cannot show diff."
				console.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: errorMessage,
				})
				relinquishButton()
				return
			}

			console.log(`[TaskCheckpointManager] presentMultifileDiff for task ${this.task.taskId}, messageTs: ${messageTs}`)
			const clineMessages = this.services.messageStateHandler.getClineMessages()
			const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
			const message = clineMessages[messageIndex]
			if (!message) {
				console.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
				relinquishButton()
				return
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				console.error(
					`[TaskCheckpointManager] No checkpoint hash found for message ${messageTs} in task ${this.task.taskId}`,
				)
				relinquishButton()
				return
			}

			// Initialize checkpoint tracker if needed
			if (!this.state.checkpointTracker && this.config.enableCheckpoints && !this.state.checkpointManagerErrorMessage) {
				try {
					const workspacePath = await this.getWorkspacePath()
					this.state.checkpointTracker = await CheckpointTracker.create(
						this.task.taskId,
						this.config.enableCheckpoints,
						workspacePath,
					)
					this.services.messageStateHandler.setCheckpointTracker(this.state.checkpointTracker)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					console.error(
						`[TaskCheckpointManager] Failed to initialize checkpoint tracker for task ${this.task.taskId}:`,
						errorMessage,
					)
					this.state.checkpointManagerErrorMessage = errorMessage
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: errorMessage,
					})
					relinquishButton()
					return
				}
			}

			if (!this.state.checkpointTracker) {
				console.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Checkpoint tracker not available",
				})
				relinquishButton()
				return
			}

			let changedFiles:
				| {
						relativePath: string
						absolutePath: string
						before: string
						after: string
				  }[]
				| undefined

			if (seeNewChangesSinceLastTaskCompletion) {
				// Get last task completed
				const lastTaskCompletedMessageCheckpointHash = findLast(
					this.services.messageStateHandler.getClineMessages().slice(0, messageIndex),
					(m) => m.say === "completion_result",
				)?.lastCheckpointHash

				// This value *should* always exist
				const firstCheckpointMessageCheckpointHash = this.services.messageStateHandler
					.getClineMessages()
					.find((m) => m.say === "checkpoint_created")?.lastCheckpointHash

				const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

				if (!previousCheckpointHash) {
					const errorMessage = "Unexpected error: No checkpoint hash found"
					console.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: errorMessage,
					})
					relinquishButton()
					return
				}

				// Get changed files between current state and commit
				changedFiles = await this.state.checkpointTracker.getDiffSet(previousCheckpointHash, hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "No changes found",
					})
					relinquishButton()
					return
				}
			} else {
				// Get changed files between current state and commit
				changedFiles = await this.state.checkpointTracker.getDiffSet(hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "No changes found",
					})
					relinquishButton()
					return
				}
			}

			// Open multi-diff editor
			const title = seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot"
			const diffs = changedFiles.map((file) => ({
				filePath: file.absolutePath,
				leftContent: file.before,
				rightContent: file.after,
			}))
			await HostProvider.diff.openMultiFileDiff({ title, diffs })

			relinquishButton()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error(`[TaskCheckpointManager] Failed to present multifile diff for task ${this.task.taskId}:`, errorMessage)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to retrieve diff set: " + errorMessage,
			})
			relinquishButton()
		}
	}

	/**
	 * Creates a checkpoint commit in the underlying tracker
	 * @returns Promise<string | undefined> The created commit hash, or undefined if failed
	 */
	async commit(): Promise<string | undefined> {
		try {
			if (!this.config.enableCheckpoints) {
				return undefined
			}

			if (!this.state.checkpointTracker) {
				await this.checkpointTrackerCheckAndInit()
			}

			if (!this.state.checkpointTracker) {
				console.error(`[TaskCheckpointManager] Checkpoint tracker not available for commit in task ${this.task.taskId}`)
				return undefined
			}

			return await this.state.checkpointTracker.commit()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error(
				`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`,
				errorMessage,
			)
			return undefined
		}
	}

	/**
	 * Checks if the latest task completion has new changes
	 * @returns Promise<boolean> - True if there are new changes since last completion
	 */
	async doesLatestTaskCompletionHaveNewChanges(): Promise<boolean> {
		try {
			if (!this.config.enableCheckpoints) {
				return false
			}

			const clineMessages = this.services.messageStateHandler.getClineMessages()
			const messageIndex = findLastIndex(clineMessages, (m) => m.say === "completion_result")
			const message = clineMessages[messageIndex]
			if (!message) {
				console.error(`[TaskCheckpointManager] Completion message not found for task ${this.task.taskId}`)
				return false
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				console.error(
					`[TaskCheckpointManager] No checkpoint hash found for completion message in task ${this.task.taskId}`,
				)
				return false
			}

			if (this.config.enableCheckpoints && !this.state.checkpointTracker && !this.state.checkpointManagerErrorMessage) {
				try {
					const workspacePath = await this.getWorkspacePath()
					this.state.checkpointTracker = await CheckpointTracker.create(
						this.task.taskId,
						this.config.enableCheckpoints,
						workspacePath,
					)
					this.services.messageStateHandler.setCheckpointTracker(this.state.checkpointTracker)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					console.error(
						`[TaskCheckpointManager] Failed to initialize checkpoint tracker for task ${this.task.taskId}:`,
						errorMessage,
					)
					await this.setcheckpointManagerErrorMessage(errorMessage)
					return false
				}
			}

			if (!this.state.checkpointTracker) {
				console.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
				return false
			}

			// Get last task completed
			const lastTaskCompletedMessage = findLast(
				this.services.messageStateHandler.getClineMessages().slice(0, messageIndex),
				(m) => m.say === "completion_result",
			)

			// Get last task completed
			const lastTaskCompletedMessageCheckpointHash = lastTaskCompletedMessage?.lastCheckpointHash

			// This value *should* always exist
			const firstCheckpointMessageCheckpointHash = this.services.messageStateHandler
				.getClineMessages()
				.find((m) => m.say === "checkpoint_created")?.lastCheckpointHash

			const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

			if (!previousCheckpointHash) {
				console.error(`[TaskCheckpointManager] No previous checkpoint hash found for task ${this.task.taskId}`)
				return false
			}

			// Get count of changed files between current state and commit
			const changedFilesCount = (await this.state.checkpointTracker.getDiffCount(previousCheckpointHash, hash)) || 0
			return changedFilesCount > 0
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error(`[TaskCheckpointManager] Failed to check for new changes in task ${this.task.taskId}:`, errorMessage)
			return false
		}
	}

	/**
	 * Handles the successful restoration logic for different restore types
	 */
	// Largely unchanged from original Task class implementation
	private async handleSuccessfulRestore(
		restoreType: ClineCheckpointRestore,
		message: ClineMessage,
		messageIndex: number,
		messageTs: number,
	): Promise<void> {
		switch (restoreType) {
			case "task":
			case "taskAndWorkspace":
				// Update conversation history deleted range in our state
				this.state.conversationHistoryDeletedRange = message.conversationHistoryDeletedRange

				const apiConversationHistory = this.services.messageStateHandler.getApiConversationHistory()
				const newConversationHistory = apiConversationHistory.slice(0, (message.conversationHistoryIndex || 0) + 2) // +1 since this index corresponds to the last user message, and another +1 since slice end index is exclusive
				await this.services.messageStateHandler.overwriteApiConversationHistory(newConversationHistory)

				// update the context history state
				const contextManager = new ContextManager()
				await contextManager.truncateContextHistory(message.ts, await ensureTaskDirectoryExists(this.task.taskId))

				// aggregate deleted api reqs info so we don't lose costs/tokens
				const clineMessages = this.services.messageStateHandler.getClineMessages()
				const deletedMessages = clineMessages.slice(messageIndex + 1)
				const deletedApiReqsMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(deletedMessages)))

				// Detect files edited after this message timestamp for file context warning
				// Only needed for task-only restores when a user edits a message or restores the task context, but not the files.
				if (restoreType === "task") {
					const filesEditedAfterMessage = await this.services.fileContextTracker.detectFilesEditedAfterMessage(
						messageTs,
						deletedMessages,
					)
					if (filesEditedAfterMessage.length > 0) {
						await this.services.fileContextTracker.storePendingFileContextWarning(filesEditedAfterMessage)
					}
				}

				const newClineMessages = clineMessages.slice(0, messageIndex + 1)
				await this.services.messageStateHandler.overwriteClineMessages(newClineMessages) // calls saveClineMessages which saves historyItem

				await this.callbacks.say(
					"deleted_api_reqs",
					JSON.stringify({
						tokensIn: deletedApiReqsMetrics.totalTokensIn,
						tokensOut: deletedApiReqsMetrics.totalTokensOut,
						cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
						cacheReads: deletedApiReqsMetrics.totalCacheReads,
						cost: deletedApiReqsMetrics.totalCost,
					} satisfies ClineApiReqInfo),
				)
				break
			case "workspace":
				break
		}

		switch (restoreType) {
			case "task":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task messages have been restored to the checkpoint",
				})
				break
			case "workspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Workspace files have been restored to the checkpoint",
				})
				break
			case "taskAndWorkspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task and workspace have been restored to the checkpoint",
				})
				break
		}

		if (restoreType !== "task") {
			// Set isCheckpointCheckedOut flag on the message
			// Find all checkpoint messages before this one
			const checkpointMessages = this.services.messageStateHandler
				.getClineMessages()
				.filter((m) => m.say === "checkpoint_created")
			const currentMessageIndex = checkpointMessages.findIndex((m) => m.ts === messageTs)

			// Set isCheckpointCheckedOut to false for all checkpoint messages
			checkpointMessages.forEach((m, i) => {
				m.isCheckpointCheckedOut = i === currentMessageIndex
			})
		}

		await this.services.messageStateHandler.saveClineMessagesAndUpdateHistory()

		// Cancel and reinitialize the task to get updated messages
		await this.callbacks.cancelTask()
	}

	// ============================================================================
	// State management - interfaces for updating internal state
	// ============================================================================

	/**
	 * Checks for an active checkpoint tracker instance, creates if needed
	 * Uses promise-based synchronization to prevent race conditions when called concurrently
	 */
	async checkpointTrackerCheckAndInit(): Promise<CheckpointTracker | undefined> {
		// If tracker already exists or there was an error, return immediately
		if (this.state.checkpointTracker) {
			return this.state.checkpointTracker
		}

		// If initialization is already in progress, wait for it to complete
		if (this.state.checkpointTrackerInitPromise) {
			return await this.state.checkpointTrackerInitPromise
		}

		// Start initialization and store the promise to prevent concurrent attempts
		this.state.checkpointTrackerInitPromise = this.initializeCheckpointTracker()

		try {
			const tracker = await this.state.checkpointTrackerInitPromise
			return tracker
		} finally {
			// Clear the promise once initialization is complete (success or failure)
			this.state.checkpointTrackerInitPromise = undefined
		}
	}

	/**
	 * Internal method to actually create the checkpoint tracker
	 */
	private async initializeCheckpointTracker(): Promise<CheckpointTracker | undefined> {
		// Warning Timer - If checkpoints take a while to initialize, show a warning message
		let checkpointsWarningTimer: NodeJS.Timeout | null = null
		let checkpointsWarningShown = false

		try {
			checkpointsWarningTimer = setTimeout(async () => {
				if (!checkpointsWarningShown) {
					checkpointsWarningShown = true
					await this.setcheckpointManagerErrorMessage(
						"Checkpoints are taking longer than expected to initialize. Working in a large repository? Consider re-opening Cline in a project that uses git, or disabling checkpoints.",
					)
				}
			}, 7_000)

			// Timeout - If checkpoints take too long to initialize, warn user and disable checkpoints for the task
			const workspacePath = await this.getWorkspacePath()
			const tracker = await pTimeout(
				CheckpointTracker.create(this.task.taskId, this.config.enableCheckpoints, workspacePath),
				{
					milliseconds: 15_000,
					message:
						"Checkpoints taking too long to initialize. Consider re-opening Cline in a project that uses git, or disabling checkpoints.",
				},
			)

			// Update the state with the created tracker
			this.state.checkpointTracker = tracker
			return tracker
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error("Failed to initialize checkpoint tracker:", errorMessage)

			// If the error was a timeout, we disable all checkpoint operations for the rest of the task
			if (errorMessage.includes("Checkpoints taking too long to initialize")) {
				await this.setcheckpointManagerErrorMessage(
					"Checkpoints initialization timed out. Consider re-opening Cline in a project that uses git, or disabling checkpoints.",
				)
			} else {
				await this.setcheckpointManagerErrorMessage(errorMessage)
			}
			return undefined
		} finally {
			// Always clean up the timer to prevent memory leaks
			if (checkpointsWarningTimer) {
				clearTimeout(checkpointsWarningTimer)
				checkpointsWarningTimer = null
			}
		}
	}

	/**
	 * Updates the checkpoint tracker instance
	 */
	setCheckpointTracker(checkpointTracker: CheckpointTracker | undefined): void {
		this.state.checkpointTracker = checkpointTracker
	}

	/**
	 * Updates the checkpoint tracker error message and posts to webview
	 */
	async setcheckpointManagerErrorMessage(errorMessage: string | undefined): Promise<void> {
		this.state.checkpointManagerErrorMessage = errorMessage
		this.taskState.checkpointManagerErrorMessage = errorMessage
		// Post state to webview so users can see the error message immediately
		try {
			await this.callbacks.postStateToWebview()
		} catch (error) {
			console.error("Failed to post state to webview after checkpoint error:", error)
		}
		// TODO - Future telemetry event capture here
	}

	/**
	 * Updates the conversation history deleted range
	 */
	updateConversationHistoryDeletedRange(range: [number, number] | undefined): void {
		this.state.conversationHistoryDeletedRange = range
		// TODO - Future telemetry event capture here
	}

	// ============================================================================
	// Internal utilities - Private helpers for checkpoint operations
	// ============================================================================

	/**
	 * Gets the workspace path from WorkspaceRootManager when available, otherwise falls back to CheckpointUtils
	 * @returns Promise<string> The workspace path to use for checkpoint operations
	 */
	private async getWorkspacePath(): Promise<string> {
		// Try to use the centralized WorkspaceRootManager first
		if (this.services.workspaceManager) {
			try {
				const primaryRoot = this.services.workspaceManager.getPrimaryRoot()
				if (primaryRoot) {
					return primaryRoot.path
				}
				console.warn(`[TaskCheckpointManager] WorkspaceRootManager returned no primary root for task ${this.task.taskId}`)
			} catch (error) {
				console.warn(
					`[TaskCheckpointManager] Failed to get workspace path from WorkspaceRootManager for task ${this.task.taskId}:`,
					error,
				)
			}
		}

		// Fallback to the legacy CheckpointUtils implementation
		const { getWorkingDirectory: getWorkingDirectoryImpl } = await import("./CheckpointUtils")
		return getWorkingDirectoryImpl()
	}

	/**
	 * Provides read-only access to current state for internal operations
	 */
	//private get currentState(): Readonly<CheckpointManagerInternalState> {
	//	return Object.freeze({ ...this.state })
	//}

	/**
	 * Provides public read-only access to current state
	 */
	public getCurrentState(): Readonly<CheckpointManagerInternalState> {
		return Object.freeze({ ...this.state })
	}

	/**
	 * Provides read-only access to dependencies for internal operations
	 */
	//private get deps(): Readonly<CheckpointManagerDependencies> {
	//	return this.dependencies
	//}

	/**
	 * Generates a checkpoint summary using LLM analysis of recent messages
	 */
	private async generateCheckpointSummary(recentMessages: ClineMessage[]): Promise<string> {
		// If no API handler available, fall back to hardcoded method
		if (!this.services.api) {
			return this.generateCheckpointSummaryFallback(recentMessages)
		}

		try {
			// Prepare the conversation context for the LLM
			const conversationContext = recentMessages
				.slice(-20) // Look at last 20 messages for context
				.map((msg) => {
					let content = `${msg.say}: `
					if (msg.text) {
						content += msg.text.substring(0, 200) // Limit text length
					}
					return content
				})
				.join("\n")

			// Create the prompt for summary generation
			const systemPrompt = `You are an expert at analyzing AI assistant conversations and creating concise, informative summaries of what was accomplished.

Your task is to analyze the recent conversation messages and generate a brief summary (1-2 sentences) of what the AI assistant accomplished in this checkpoint period.

Focus on:
- Specific files that were read, modified, or created
- Commands that were executed
- Tasks that were completed
- Key actions taken

Be specific and actionable. Avoid generic phrases like "worked on files" - instead say "modified package.json and updated index.ts".

Keep the summary under 100 characters if possible, but make it meaningful.

If there's no clear accomplishment, return "Progress checkpoint created".`

			const userPrompt = `Analyze these recent conversation messages and summarize what was accomplished:

${conversationContext}

Generate a concise summary of the key accomplishments:`

			// Create the API request
			const messages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: systemPrompt + "\n\n" + userPrompt,
						},
					],
				},
			]

			// Make the API call
			const stream = this.services.api.createMessage(systemPrompt, messages)

			let summary = ""
			for await (const chunk of stream) {
				if (chunk.type === "text" && chunk.text) {
					summary += chunk.text
				}
			}

			// Clean up the summary
			summary = summary.trim()

			// Limit length and ensure it's meaningful
			if (summary.length > 120) {
				summary = summary.substring(0, 117) + "..."
			}

			// If summary is too short or generic, fall back
			if (summary.length < 5 || summary.toLowerCase().includes("checkpoint created")) {
				return this.generateCheckpointSummaryFallback(recentMessages)
			}

			return summary
		} catch (error) {
			console.error("[TaskCheckpointManager] Failed to generate LLM summary:", error)
			// Fall back to hardcoded method on error
			return this.generateCheckpointSummaryFallback(recentMessages)
		}
	}

	/**
	 * Fallback checkpoint summary generation using hardcoded logic
	 */
	private generateCheckpointSummaryFallback(recentMessages: ClineMessage[]): string {
		// Collect detailed information for remote supervision
		const actions: string[] = []
		const filesAccessed: string[] = []
		const commandsExecuted: string[] = []
		const tasksCompleted: string[] = []
		const lastUserMessage = ""
		let lastAssistantMessage = ""

		for (const message of recentMessages.reverse()) {
			// Process in reverse chronological order (most recent first)
			// Check for tool usage - extract detailed information
			if ((message as any).tool) {
				try {
					const toolData =
						typeof (message as any).tool === "string" ? JSON.parse((message as any).tool) : (message as any).tool
					const toolName = toolData.tool || toolData.name

					switch (toolName) {
						case "readFile":
						case "read_file":
							if (toolData.path) {
								const fileName = toolData.path.split("/").pop() || toolData.path
								filesAccessed.push(`read ${fileName}`)
								actions.push(`read ${fileName}`)
							} else {
								actions.push("read file content")
							}
							break
						case "listDir":
						case "list_files":
							if (toolData.path) {
								const dirName = toolData.path.split("/").pop() || toolData.path
								actions.push(`explored ${dirName} directory`)
							} else {
								actions.push("explored directory structure")
							}
							break
						case "grepSearch":
						case "search_files":
							if (toolData.regex) {
								actions.push(`searched for "${toolData.regex}"`)
							} else {
								actions.push("searched codebase")
							}
							break
						case "runTerminalCmd":
						case "runTerminalCmdAndWait":
						case "execute_command":
							if (toolData.command) {
								const cmd = toolData.command.split(" ")[0] // Get the main command
								commandsExecuted.push(cmd)
								actions.push(`ran ${cmd}`)
							} else {
								actions.push("executed commands")
							}
							break
						case "replace_in_file":
							if (toolData.path) {
								const fileName = toolData.path.split("/").pop() || toolData.path
								filesAccessed.push(`modified ${fileName}`)
								actions.push(`modified ${fileName}`)
							} else {
								actions.push("modified files")
							}
							break
						case "write_to_file":
							if (toolData.path) {
								const fileName = toolData.path.split("/").pop() || toolData.path
								filesAccessed.push(`created ${fileName}`)
								actions.push(`created ${fileName}`)
							} else {
								actions.push("created files")
							}
							break
						case "attempt_completion":
							actions.push("completed task segment")
							break
						case "newTask":
							actions.push("started new task")
							break
						case "ask_followup_question":
							actions.push("gathered requirements")
							break
						case "use_mcp_tool":
							if (toolData.toolName) {
								actions.push(`used ${toolData.toolName}`)
							} else {
								actions.push("used external tools")
							}
							break
						case "access_mcp_resource":
							actions.push("accessed external resources")
							break
						default:
							if (toolName && toolName.includes("search")) {
								actions.push("searched codebase")
							} else if (toolName && toolName.includes("read")) {
								actions.push("read file content")
							} else if ((toolName && toolName.includes("write")) || toolName.includes("replace")) {
								actions.push("modified files")
							} else if ((toolName && toolName.includes("run")) || toolName.includes("execute")) {
								actions.push("executed commands")
							}
							break
					}
				} catch (e) {
					// If parsing fails, try to extract from string representation
					const toolStr =
						typeof (message as any).tool === "string" ? (message as any).tool : JSON.stringify((message as any).tool)
					if (toolStr.includes("readFile") || toolStr.includes("read_file")) {
						actions.push("read file content")
					} else if (toolStr.includes("runTerminal") || toolStr.includes("execute_command")) {
						actions.push("executed commands")
					} else if (toolStr.includes("replace_in_file")) {
						actions.push("modified files")
					} else if (toolStr.includes("write_to_file")) {
						actions.push("created files")
					}
				}
			}

			// Check for task progress updates with specific task details
			if (message.say === "task_progress" && message.text) {
				const lines = message.text.split("\n")
				const completedItems = lines.filter((line) => line.includes("[x]"))
				const pendingItems = lines.filter((line) => line.includes("[ ]"))

				completedItems.forEach((line) => {
					const taskMatch = line.match(/-\s*\[x\]\s*(.+)/)
					if (taskMatch) {
						const task = taskMatch[1].trim()
						tasksCompleted.push(task)
						actions.push(`completed "${task}"`)
					}
				})

				if (completedItems.length > 0) {
					actions.push(`completed ${completedItems.length} task steps`)
				}
			}

			// Check for reasoning messages (these often contain detailed action descriptions)
			if (message.say === "reasoning" && message.text) {
				const reasoning = message.text.toLowerCase()
				if (reasoning.includes("read") || reasoning.includes("examine") || reasoning.includes("analyze")) {
					actions.push("analyzed code")
				} else if (reasoning.includes("modify") || reasoning.includes("update") || reasoning.includes("change")) {
					actions.push("modified files")
				} else if (reasoning.includes("run") || reasoning.includes("execute") || reasoning.includes("command")) {
					actions.push("executed commands")
				} else if (reasoning.includes("search") || reasoning.includes("find")) {
					actions.push("searched codebase")
				}
			}

			// Check for text messages (assistant responses with detailed information)
			if (message.say === "text" && message.text) {
				const text = message.text.toLowerCase().trim()

				// Skip very short messages or system messages
				if (text.length < 10) continue

				// Look for specific file operations
				const fileMatch = text.match(/(?:read|opened|modified|created|updated|edited)\s+([^.\n]+)/i)
				if (fileMatch) {
					const fileDesc = fileMatch[1].trim()
					if (
						fileDesc.includes("file") ||
						fileDesc.includes(".js") ||
						fileDesc.includes(".ts") ||
						fileDesc.includes(".py")
					) {
						actions.push(`worked on ${fileDesc}`)
					}
				}

				// Look for command executions
				const cmdMatch = text.match(/(?:ran|executed)\s+([^.\n]+)/i)
				if (cmdMatch) {
					const cmd = cmdMatch[1].trim()
					actions.push(`ran ${cmd}`)
				}

				// Store the last meaningful message for fallback
				if (text.length > 20) {
					lastAssistantMessage = message.text.substring(0, 80).trim()
				}
			}

			// Check for completion results
			else if (message.say === "completion_result" && message.text) {
				const completionText = message.text.substring(0, 150).toLowerCase()
				if (
					completionText.includes("success") ||
					completionText.includes("complete") ||
					completionText.includes("done")
				) {
					actions.push("completed task segment")
				}
				// Store completion result as fallback
				lastAssistantMessage = message.text.substring(0, 80).trim()
			}

			// Check for ask states (indicates waiting for user input)
			else if (message.ask === "command") {
				actions.push("executed commands")
			} else if (message.ask === "completion_result") {
				actions.push("completed task segment")
			}
		}

		// Create detailed summary prioritizing specific information
		const summaryParts: string[] = []

		// Add specific file operations - show all unique operations, not just count
		if (filesAccessed.length > 0) {
			const uniqueFiles = [...new Set(filesAccessed)]
			if (uniqueFiles.length <= 3) {
				summaryParts.push(uniqueFiles.join(", "))
			} else {
				// Show the most recent 2-3 operations
				const recentFiles = uniqueFiles.slice(-3)
				summaryParts.push(`${recentFiles.join(", ")} (+${uniqueFiles.length - 3} more)`)
			}
		}

		// Add specific tasks completed - show the most recent completed task
		if (tasksCompleted.length > 0) {
			const uniqueTasks = [...new Set(tasksCompleted)]
			if (uniqueTasks.length === 1) {
				summaryParts.push(`completed "${uniqueTasks[0]}"`)
			} else if (uniqueTasks.length <= 3) {
				summaryParts.push(`completed "${uniqueTasks.slice(-1)[0]}" (+${uniqueTasks.length - 1} more tasks)`)
			} else {
				summaryParts.push(`completed "${uniqueTasks.slice(-1)[0]}" (+${uniqueTasks.length - 1} more tasks)`)
			}
		}

		// Add command executions - show all unique commands executed
		if (commandsExecuted.length > 0) {
			const uniqueCommands = [...new Set(commandsExecuted)]
			if (uniqueCommands.length <= 3) {
				summaryParts.push(`ran ${uniqueCommands.join(", ")}`)
			} else {
				// Show the most recent 2-3 commands
				const recentCommands = uniqueCommands.slice(-3)
				summaryParts.push(`ran ${recentCommands.join(", ")} (+${uniqueCommands.length - 3} more)`)
			}
		}

		// If we have specific details, use them
		if (summaryParts.length > 0) {
			const summary = summaryParts.slice(0, 2).join("; ")
			return summary.charAt(0).toUpperCase() + summary.slice(1)
		}

		// Fallback to general actions
		const uniqueActions = [...new Set(actions)]
		if (uniqueActions.length > 0) {
			const summary = uniqueActions.slice(0, 2).join(" and ")
			const result = summary.charAt(0).toUpperCase() + summary.slice(1)
			return result
		}

		// Try to extract a meaningful summary from the last assistant message
		if (lastAssistantMessage && lastAssistantMessage.length > 10) {
			// Clean up the message and use it as summary
			let summary = lastAssistantMessage
			// Remove common prefixes
			summary = summary
				.replace(/^I've\s+/i, "")
				.replace(/^I\s+/i, "")
				.replace(/^The\s+/i, "")
			// Capitalize first letter
			summary = summary.charAt(0).toUpperCase() + summary.slice(1)
			// Limit length
			if (summary.length > 100) {
				summary = summary.substring(0, 97) + "..."
			}
			return summary
		}

		// Final fallback
		return "Progress checkpoint created"
	}
}

// ============================================================================
// Factory function for clean instantiation
// ============================================================================

/**
 * Creates a new TaskCheckpointManager instance
 */
export function createTaskCheckpointManager(
	task: CheckpointManagerTask,
	config: CheckpointManagerConfig,
	services: CheckpointManagerServices,
	callbacks: CheckpointManagerCallbacks,
	initialState: CheckpointManagerInternalState,
): TaskCheckpointManager {
	return new TaskCheckpointManager(task, config, services, callbacks, initialState)
}
