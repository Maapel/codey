import type { EmptyRequest } from "@shared/proto/codey/common"
import { Empty } from "@shared/proto/codey/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import type { Controller } from "../index"

/**
 * Opens the Codey walkthrough in VSCode
 * @param controller The controller instance
 * @param request Empty request
 * @returns Empty response
 */
export async function openWalkthrough(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`saoudrizwan.${ExtensionRegistryInfo.name}#ClineWalkthrough`,
		)
		telemetryService.captureButtonClick("webview_openWalkthrough")
		return Empty.create({})
	} catch (error) {
		console.error(`Failed to open walkthrough: ${error}`)
		throw error
	}
}
