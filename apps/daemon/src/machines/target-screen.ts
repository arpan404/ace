import type { MachineToolResult } from "@ace/protocol";
import { ToolRegistry, nodeScheduler, type Toolkit } from "@ace/mcp-server";
import type { ComputerClient } from "@ace/screen";
import type { CapabilityHost } from "./capability-hosts.ts";
import type { GuestSession } from "./guest-sessions.ts";
import { TargetRefusal } from "./target-refusal.ts";
import { toolResult } from "./tool-result.ts";

export interface TargetScreenDeps {
  /** This machine's computer-use engine, when it has one. */
  computer(): ComputerClient | undefined;
  /** The person's computer-use switch here (Settings › Computer use), read on every call. */
  enabled(): boolean;
  /** This machine's own computer-use tools over that engine, with its rules. */
  toolkit(computer: ComputerClient): Toolkit;
}

/** The tools that only look (ADR 0105); every other tool acts. */
const reads = new Set(["screen_apps", "screen_state"]);
/** Base64 characters of pictures in one reply, well inside the 8 MB a reply may carry. */
const pictureBudget = 6 * 1024 * 1024;
/** Calling agents whose looks this machine remembers at once; the oldest is forgotten first. */
const remembered = 32;

interface Held {
  computer: ComputerClient;
  tools: ToolRegistry;
  threadId: string;
}

/**
 * Computer use for agents on other machines (ADR 0105). Their calls run this machine's own
 * screen_* tools, as the calling thread's guest session, so its computer-use switch, blocked
 * apps, Locked Use rules and "using apps" mark apply exactly as for an agent here. Each calling
 * agent gets its own tools, so its outline diffs are its own; they are let go when its work ends.
 */
export class TargetScreen implements CapabilityHost {
  private deps: TargetScreenDeps;
  private held = new Map<string, Held>();
  constructor(deps: TargetScreenDeps) {
    this.deps = deps;
  }
  available(): boolean {
    return this.deps.computer() !== undefined && this.deps.enabled();
  }
  unavailable(): string {
    return this.deps.computer()
      ? "Computer use is off on that machine. The person can turn it on there in Settings › Computer use."
      : "That machine has no computer use.";
  }
  readOnly(tool: string): boolean {
    return reads.has(tool);
  }
  async call(
    session: GuestSession,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MachineToolResult> {
    const computer = this.deps.computer();
    if (!computer || !this.deps.enabled())
      throw new TargetRefusal("unavailable", this.unavailable());
    const tools = this.tools(session, computer);
    if (!tools.names().includes(tool))
      throw new TargetRefusal("invalid", "Unknown computer-use tool.");
    const result = await tools.call(
      tool,
      args,
      {
        scope: {
          sessionId: `machine:${session.deviceId}`,
          threadId: session.threadId,
          agentId: session.agentId,
          capabilities: ["screen"],
        },
        signal,
      },
      signal,
    );
    return withinBudget(toolResult(result));
  }
  /** Forgets what the guest session's agents looked at, once its work ended or was revoked. */
  release(threadId: string): void {
    for (const [owner, held] of this.held) if (held.threadId === threadId) this.held.delete(owner);
  }
  private tools(session: GuestSession, computer: ComputerClient): ToolRegistry {
    const existing = this.held.get(session.owner);
    if (existing?.computer === computer) {
      // Most recent last, so the oldest is the one forgotten.
      this.held.delete(session.owner);
      this.held.set(session.owner, existing);
      return existing.tools;
    }
    const tools = new ToolRegistry({ scheduler: nodeScheduler });
    this.deps.toolkit(computer).register(tools);
    this.held.set(session.owner, { computer, tools, threadId: session.threadId });
    for (const owner of this.held.keys()) {
      if (this.held.size <= remembered) break;
      this.held.delete(owner);
    }
    return tools;
  }
}

/** Pictures past the budget are left out, with a line saying so; text always crosses. */
function withinBudget(result: MachineToolResult): MachineToolResult {
  let spent = 0;
  let dropped = false;
  const content = result.content.filter((part) => {
    if (part.type !== "image") return true;
    spent += part.data.length;
    if (spent <= pictureBudget) return true;
    dropped = true;
    return false;
  });
  if (dropped)
    content.splice(Math.min(content.length, 15), 1, {
      type: "text",
      text: "The screenshot was left out: too large to send between machines. Look again without screenshot, or at a smaller window.",
    });
  return { ...result, content };
}
