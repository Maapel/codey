import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { memo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface DashboardSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const DashboardSection = ({ renderSectionHeader }: DashboardSectionProps) => {
	const { dashboardSettings } = useExtensionState()

	return (
		<div>
			{renderSectionHeader("dashboard")}
			<Section>
				<div style={{ marginBottom: 20 }}>
					<VSCodeCheckbox
						checked={dashboardSettings?.enabled || false}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							const newSettings = { ...dashboardSettings, enabled: checked }
							updateSetting("dashboardSettings", newSettings)
						}}>
						Enable Dashboard Integration
					</VSCodeCheckbox>
					<p className="text-xs text-[var(--vscode-descriptionForeground)]">
						Enable integration with external dashboard for task progress tracking and reporting.
					</p>
				</div>

				{dashboardSettings?.enabled && (
					<>
						<div style={{ marginTop: 10, marginLeft: 20 }}>
							<label className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">Session Name</label>
							<VSCodeTextField
								className="w-full"
								onChange={(e: any) => {
									const value = e.target.value
									const newSettings = { ...dashboardSettings, sessionName: value }
									updateSetting("dashboardSettings", newSettings)
								}}
								placeholder="Enter session name"
								value={dashboardSettings?.sessionName || ""}
							/>
							<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
								Unique identifier for this session used when communicating with the dashboard.
							</p>
						</div>

						<div style={{ marginTop: 10, marginLeft: 20 }}>
							<label className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">
								Dashboard URL (Optional)
							</label>
							<VSCodeTextField
								className="w-full"
								onChange={(e: any) => {
									const value = e.target.value
									const newSettings = { ...dashboardSettings, dashboardUrl: value }
									updateSetting("dashboardSettings", newSettings)
								}}
								placeholder="https://your-dashboard.com"
								value={dashboardSettings?.dashboardUrl || ""}
							/>
							<p className="text-xs mt-[5px] text-[var(--vscode-descriptionForeground)]">
								Optional: URL of your dashboard endpoint.
							</p>
						</div>
					</>
				)}
			</Section>
		</div>
	)
}

export default memo(DashboardSection)
