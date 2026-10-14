import { createHash } from "node:crypto";
import {
  AgentId,
  Command,
  ProviderKind,
  ThreadId,
  type Device,
  type MachineCallOrigin,
  type MachineToolResult,
} from "@ace/protocol";
import type { BrowserService } from "@ace/browser";
import { ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { commandContext } from "../commands.ts";
import { browserToolkit } from "../browser-toolkit.ts";
import { clip } from "../agent-control/watch-view.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { TargetThreads } from "./target-threads.ts";

export interface TargetBrowserDeps {
  store: Store;
  engine(): Engine | undefined;
  browser(): BrowserService | undefined;
  threads: TargetThreads;
}

/**
 * Browser tools for agents on other machines run here, through this machine's own browser tool
 * registry, in a thread of this machine's that belongs to the calling thread. Its origin
 * consent, approvals and takeover are this machine's, exactly as for a local agent.
 */
export class TargetBrowser {
  private deps: TargetBrowserDeps;
  private registry: { browser: BrowserService; tools: ToolRegistry } | undefined;
  constructor(deps: TargetBrowserDeps) {
    this.deps = deps;
  }
  available(): boolean {
    return this.deps.browser() !== undefined;
  }
  private tools(): ToolRegistry {
    const browser = this.deps.browser();
    if (!browser) throw new TargetRefusal("unavailable", "This machine's browser is off.");
    if (this.registry?.browser !== browser) {
      const tools = new ToolRegistry({ scheduler: nodeScheduler });
      browserToolkit(browser, this.deps.store).register(tools);
      this.registry = { browser, tools };
    }
    return this.registry.tools;
  }
  /** Whether a call only reads, so a read-only pairing or access may make it. */
  readOnly(tool: string, args: Record<string, unknown>): boolean {
    const tools = this.tools();
    if (!tools.names().includes(tool)) throw new TargetRefusal("invalid", "Unknown browser tool.");
    return tools.action(tool, args)?.riskClass === "read-only";
  }
  /** One browser session per calling thread, held by an ordinary thread on this machine. */
  session(device: Device, origin: MachineCallOrigin): ThreadId {
    const { store } = this.deps;
    const engine = this.deps.engine();
    if (!engine) throw new TargetRefusal("unavailable", "Agents are starting on this machine.");
    const key = createHash("sha256")
      .update(JSON.stringify([device.id, origin.hostId, origin.threadId]))
      .digest("hex")
      .slice(0, 32);
    const threadId = ThreadId.parse(`machine-browser-${key}`);
    if (store.getThread(threadId) && this.deps.threads.owner(threadId)?.device_id === device.id)
      return threadId;
    const provider = ProviderKind.options.find(
      (kind) => engine.providerAvailability(kind).installed,
    );
    const [project] = this.deps.threads.projects();
    if (!provider || !project)
      throw new TargetRefusal("unavailable", "Add a project and an agent on this machine first.");
    const command = Command.parse({
      id: `machine-browser:${key}`,
      deviceId: device.id,
      payload: {
        type: "thread.prepare",
        threadId,
        workspaceId: project.workspaceId,
        provider,
        mode: "local",
        title: clip(`Browser for ${origin.hostName} · ${origin.threadTitle}`, 256),
      },
    });
    const result = store.recordCommand(command.id, command.deviceId, () =>
      engine.internalHandler.handle(command, commandContext(store)),
    );
    if (!result.ok)
      throw new TargetRefusal(
        "unavailable",
        `This machine could not open a browser: ${result.error}`,
      );
    this.deps.threads.record(device, threadId, "browser", origin);
    return threadId;
  }
  async call(
    device: Device,
    origin: MachineCallOrigin,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MachineToolResult> {
    const threadId = this.session(device, origin);
    const agentId = this.deps.engine()?.rootAgent(threadId);
    if (!agentId) throw new TargetRefusal("unavailable", "The browser session is not ready.");
    const result = await this.tools().call(
      tool,
      args,
      {
        scope: {
          sessionId: `machine:${device.id}`,
          threadId,
          agentId: AgentId.parse(agentId),
          capabilities: ["browser"],
        },
        signal,
      },
      signal,
    );
    const content: MachineToolResult["content"] = [];
    for (const part of result.content) {
      if (content.length >= 16) break;
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "image")
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
    return { ...(result.isError ? { isError: true } : {}), content };
  }
}
