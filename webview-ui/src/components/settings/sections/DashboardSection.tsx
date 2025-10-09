import { VSCodeCheckbox, VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface DashboardSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const DashboardSection = ({ renderSectionHeader }: DashboardSectionProps) => {
	const { dashboardIntegrationEnabled, dashboardSessionName, dashboardUrl } = useExtensionState()

	return (
		<div>
			{renderSectionHeader("dashboard")}
			<Section>
				<div style={{ marginBottom: 20 }}>
					<VSCodeCheckbox
						checked={dashboardIntegrationEnabled}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							updateSetting("dashboardIntegrationEnabled", checked)
						}}>
						Enable Dashboard Integration
					</VSCodeCheckbox>
					<p className="text-xs text-[var(--vscode-descriptionForeground)]">
						Enable integration with external dashboard for task progress tracking and reporting. When enabled, Codey
						will communicate with dashboard scripts for real-time updates.
					</p>
				</div>

				{dashboardIntegrationEnabled && (
					<>
						<div className="mb-4">
							<label className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">Session Name</label>
							<VSCodeTextField
								className="w-full"
								onChange={(e: any) => {
									const value = e.target.value
									updateSetting("dashboardSessionName", value)
								}}
								placeholder="Enter session name (e.g., code-auditor)"
								value={dashboardSessionName || ""}>
								Session Name
							</VSCodeTextField>
							<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
								Unique identifier for this Codey session used when communicating with the dashboard.
							</p>
						</div>

						<div className="mb-4">
							<label className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">
								Dashboard URL (Optional)
							</label>
							<VSCodeTextField
								className="w-full"
								onChange={(e: any) => {
									const value = e.target.value
									updateSetting("dashboardUrl", value)
								}}
								placeholder="https://your-dashboard.com"
								value={dashboardUrl || ""}>
								Dashboard URL
							</VSCodeTextField>
							<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
								Optional: URL of your dashboard endpoint. If not provided, uses default dashboard.
							</p>
						</div>

						<div className="mt-4 p-3 bg-[var(--vscode-textBlockQuote-background)] rounded border border-[var(--vscode-textBlockQuote-border)]">
							<p className="text-[13px] m-0">
								<strong>Dashboard Integration Features:</strong>
							</p>
							<ul className="text-xs mt-2 ml-4 text-[var(--vscode-descriptionForeground)]">
								<li>Real-time progress updates via update.sh</li>
								<li>Task completion reporting via report_and_fetch.sh</li>
								<li>Session-based tracking and management</li>
								<li>External dashboard communication</li>
							</ul>
							<p className="text-xs mt-2 text-[var(--vscode-descriptionForeground)]">
								See{" "}
								<VSCodeLink
									className="text-inherit"
									href="https://docs.cline.bot/features/dashboard-integration"
									style={{ fontSize: "inherit", textDecoration: "underline" }}>
									dashboard integration guide
								</VSCodeLink>{" "}
								for setup instructions.
							</p>
						</div>

						<div className="mt-4 p-3 bg-[var(--vscode-textBlockQuote-background)] rounded border border-[var(--vscode-textBlockQuote-border)]">
							<p className="text-[13px] m-0">
								<strong>Execution Status:</strong>
							</p>
							<p className="text-xs mt-2 text-[var(--vscode-descriptionForeground)]">
								Dashboard integration execution is currently in development. Scripts will be executed when this
								feature is fully implemented.
							</p>
							<div className="mt-2 text-xs text-[var(--vscode-descriptionForeground)]">
								<p>
									<strong>Status:</strong> <span className="text-yellow-600">In Development</span>
								</p>
								<p>
									<strong>Scripts:</strong> update.sh, report_and_fetch.sh
								</p>
								<p>
									<strong>Integration:</strong> Ready for testing
								</p>
							</div>
						</div>
					</>
				)}
			</Section>
		</div>
	)
}

export default DashboardSection
