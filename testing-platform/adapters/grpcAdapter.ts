import { AccountServiceClient } from "@codey-grpc/account"
import { BrowserServiceClient } from "@codey-grpc/browser"
import { CheckpointsServiceClient } from "@codey-grpc/checkpoints"
import { CommandsServiceClient } from "@codey-grpc/commands"
import { FileServiceClient } from "@codey-grpc/file"
import { McpServiceClient } from "@codey-grpc/mcp"
import { ModelsServiceClient } from "@codey-grpc/models"
import { SlashServiceClient } from "@codey-grpc/slash"
import { StateServiceClient } from "@codey-grpc/state"
import { TaskServiceClient } from "@codey-grpc/task"
import { UiServiceClient } from "@codey-grpc/ui"
import { WebServiceClient } from "@codey-grpc/web"
import { credentials } from "@grpc/grpc-js"
import { promisify } from "util"

const serviceRegistry = {
	"codey.AccountService": AccountServiceClient,
	"codey.BrowserService": BrowserServiceClient,
	"codey.CheckpointsService": CheckpointsServiceClient,
	"codey.CommandsService": CommandsServiceClient,
	"codey.FileService": FileServiceClient,
	"codey.McpService": McpServiceClient,
	"codey.ModelsService": ModelsServiceClient,
	"codey.SlashService": SlashServiceClient,
	"codey.StateService": StateServiceClient,
	"codey.TaskService": TaskServiceClient,
	"codey.UiService": UiServiceClient,
	"codey.WebService": WebServiceClient,
} as const

export type ServiceClients = {
	-readonly [K in keyof typeof serviceRegistry]: InstanceType<(typeof serviceRegistry)[K]>
}

export class GrpcAdapter {
	private clients: Partial<ServiceClients> = {}

	constructor(address: string) {
		for (const [name, Client] of Object.entries(serviceRegistry)) {
			this.clients[name as keyof ServiceClients] = new (Client as any)(address, credentials.createInsecure())
		}
	}

	async call(service: keyof ServiceClients, method: string, request: any): Promise<any> {
		const client = this.clients[service]
		if (!client) {
			throw new Error(`No gRPC client registered for service: ${String(service)}`)
		}

		const fn = (client as any)[method]
		if (typeof fn !== "function") {
			throw new Error(`Method ${method} not found on service ${String(service)}`)
		}

		try {
			const fnAsync = promisify(fn).bind(client)
			const response = await fnAsync(request.message)
			return response?.toObject ? response.toObject() : response
		} catch (error) {
			console.error(`[GrpcAdapter] ${service}.${method} failed:`, error)
			throw error
		}
	}

	close(): void {
		for (const client of Object.values(this.clients)) {
			if (client && typeof (client as any).close === "function") {
				;(client as any).close()
			}
		}
	}
}
