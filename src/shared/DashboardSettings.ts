export interface DashboardSettings {
	// Enable/disable the dashboard integration feature
	enabled: boolean
	// Session name for dashboard identification
	sessionName: string
	// Optional dashboard URL endpoint
	dashboardUrl?: string
}

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
	enabled: false,
	sessionName: "",
	dashboardUrl: "",
}
