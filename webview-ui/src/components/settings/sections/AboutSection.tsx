import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	renderSectionHeader: (tabId: string) => JSX.Element | null
}
const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div style={{ padding: "0 16px" }}>
					<h2>Codey v{version}</h2>
					<p>
						An AI assistant that can use your CLI and Editor. Codey can handle complex software development tasks
						step-by-step with tools that let him create & edit files, explore large projects, use the browser, and
						execute terminal commands (after you grant permission).
					</p>

					<h3>Community & Support</h3>
					<p>
						<VSCodeLink href="https://x.com/codey">X</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://discord.gg/codey">Discord</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://www.reddit.com/r/codey/"> r/codey</VSCodeLink>
					</p>

					<h3>Development</h3>
					<p>
						<VSCodeLink href="https://github.com/codey/codey">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/codey/codey/issues"> Issues</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/codey/codey/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop">
							{" "}
							Feature Requests
						</VSCodeLink>
					</p>

					<h3>Resources</h3>
					<p>
						<VSCodeLink href="https://docs.codey.bot/getting-started/for-new-coders">Documentation</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://codey.bot/">https://codey.bot</VSCodeLink>
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
