import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface DashboardSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const DashboardSection = ({ renderSectionHeader }: DashboardSectionProps) => {
	const { dashboardSettings } = useExtensionState()
	// Local state to track changes immediately
	const [localSettings, setLocalSettings] = useState(dashboardSettings || { enabled: false, sessionName: "", dashboardUrl: "" })

	return (
		<div>
			{renderSectionHeader("dashboard")}
			<Section>
				<div style={{ marginBottom: 20 }}>
					<VSCodeCheckbox
						checked={localSettings.enabled}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							const newSettings = { ...localSettings, enabled: checked }
							setLocalSettings(newSettings)
							updateSetting("dashboardSettings", newSettings)
						}}>
						Enable Dashboard Integration
					</VSCodeCheckbox>
					<p className="text-xs text-[var(--vscode-descriptionForeground)]">
						Enable integration with external dashboard for task progress tracking and reporting.
					</p>
				</div>

				{localSettings.enabled && (
					<>
						<div style={{ marginTop: 10, marginLeft: 20 }}>
							<label className="block text-sm font-medium text-[var(--vscode-foreground)] mb-1">Session Name</label>
							<VSCodeTextField
								className="w-full"
								onChange={(e: any) => {
									const value = e.target.value
									const newSettings = { ...localSettings, sessionName: value }
									setLocalSettings(newSettings)
									updateSetting("dashboardSettings", newSettings)
								}}
								placeholder="Enter session name"
								value={localSettings.sessionName}
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
									const newSettings = { ...localSettings, dashboardUrl: value }
									setLocalSettings(newSettings)
									updateSetting("dashboardSettings", newSettings)
								}}
								placeholder="https://your-dashboard.com"
								value={localSettings.dashboardUrl}
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

export default DashboardSection
