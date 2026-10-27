import type { Device, MachineCallOrigin, MachineToolResult, ThreadId } from "@ace/protocol";
import type { BrowserService } from "@ace/browser";
import { ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import type { Store } from "../store.ts";
import { browserToolkit } from "../browser-toolkit.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { GuestSessions } from "./guest-sessions.ts";
import { toolResult } from "./tool-result.ts";

export interface TargetBrowserDeps {
  store: Store;
  browser(): BrowserService | undefined;
  guests: GuestSessions;
}

/**
 * Browser tools for agents on other machines run here, through this machine's own browser tool
 * registry, in the calling thread's guest session (ADR 0105). Its origin consent, approvals and
 * takeover are this machine's, exactly as for a local agent; no provider needs to be installed.
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
  /** The calling thread's guest session, which holds its browser and consent requests. */
  async session(device: Device, origin: MachineCallOrigin): Promise<ThreadId> {
    return (await this.deps.guests.open(device, origin)).threadId;
  }
  async call(
    device: Device,
    origin: MachineCallOrigin,
    { tool, args, ticket }: { tool: string; args: Record<string, unknown>; ticket: number },
    signal: AbortSignal,
  ): Promise<MachineToolResult> {
    const tools = this.tools();
    const session = await this.deps.guests.open(device, origin);
    const risk = this.readOnly(tool, args) ? "read" : "operate";
    return this.deps.guests.run(
      session,
      { capability: "browser", risk, label: `${tool} from ${origin.hostName}`, ticket },
      signal,
      async (stop) =>
        toolResult(
          await tools.call(
            tool,
            args,
            {
              scope: {
                sessionId: `machine:${device.id}`,
                threadId: session.threadId,
                agentId: session.agentId,
                capabilities: ["browser"],
              },
              signal: stop,
            },
            stop,
          ),
        ),
    );
  }
}
