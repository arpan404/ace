import type {
  AgentError,
  AgentId,
  EventPayload,
  Item,
  ProviderKind,
  SpadeBrainFailure,
  SpadeBrainFrame,
} from "@ace/protocol";

/** What people call each provider, for status and failure lines. */
export const providerNames: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  acp: "Your ACP agent",
  pi: "Pi",
};

/** Codes `shapeProviderError` and the adapters use for a missing or expired login. */
const signedOutCodes = new Set(["authentication_failed", "auth", "not_logged_in", "logged_out"]);
const quotaCodes = new Set(["billing_error", "model_quota", "quota", "usage_limit"]);
const rateCodes = new Set(["rate_limit", "rate_limited", "overloaded_error"]);

/** The one line a failed turn shows, by reason. Never the provider's raw text. */
export function failureLine(provider: ProviderKind, reason: SpadeBrainFailure): string {
  const name = providerNames[provider];
  switch (reason) {
    case "not_installed":
      return `${name} isn't installed on this machine. Install it in ace, then send again.`;
    case "signed_out":
      return `${name} is signed out. Sign in to it in ace, then send again.`;
    case "rate_limited":
      return `${name} is rate-limited right now. Send again in a little while.`;
    case "quota":
      return `${name}'s usage limit is reached. Send again once it resets.`;
    case "needs_permission":
      return `${name} asked for permission to act on its own; this bot acts only through Spade's tools.`;
    case "unavailable":
      return `${name} can't run here right now: turned off, or the account isn't available.`;
    case "failed":
      return `${name} stopped with an error.`;
  }
}

/** Why a run failed, from the error ace recorded on it. */
export function failureReason(error: AgentError | undefined): SpadeBrainFailure {
  if (!error) return "failed";
  const code = error.details?.code ?? error.code ?? "";
  if (error.kind === "auth" || signedOutCodes.has(code)) return "signed_out";
  if (error.kind === "quota" || quotaCodes.has(code)) return "quota";
  if (rateCodes.has(code)) return "rate_limited";
  return "failed";
}

/** Why the engine refused to start the turn, from its command error. */
export function refusalReason(error: string | undefined): SpadeBrainFailure {
  switch (error) {
    case "provider_unavailable":
      return "not_installed";
    case "provider_disabled":
    case "account_unavailable":
    case "model_unavailable":
      return "unavailable";
    default:
      return "failed";
  }
}

/** A few plain words on what a tool call is doing, never its arguments. */
function toolStatus(item: Extract<Item, { type: "tool_call" }>): string {
  switch (item.call.kind) {
    case "web.search":
      return "Searching the web";
    case "web.fetch":
      return "Reading a page";
    case "file.read":
    case "search":
      return "Reading files";
    case "shell":
      return "Running a command";
    default:
      return "Using a tool";
  }
}

const trustedAceTools = new Set([
  "spade_tools",
  "spade_call",
  "machines",
  "models",
  "projects_find",
  "automations_list",
]);

/**
 * What a tool call of the CLI's own (any agent in the session, any adapter) let into the turn,
 * or undefined only for a call known to return nothing from outside: the agent's own to-do list
 * or plan, and ace's tools that return only ace's own state. Fails closed: a kind this list
 * doesn't name (file reads, searches, shell output, custom tools) counts as outside text.
 */
function readSource(item: Extract<Item, { type: "tool_call" }>): string | undefined {
  const detail = item.call.detail;
  switch (item.call.kind) {
    case "todo":
    case "plan":
      return undefined;
    case "mcp":
      // The bot's own tools go through Spade, which judges their output itself.
      if (detail.kind === "mcp" && detail.server === "ace" && trustedAceTools.has(detail.tool))
        return undefined;
      return "another tool's output";
    case "web.search":
    case "web.fetch":
    case "browser":
      return "the web";
    case "file.read":
    case "search":
    case "notebook":
    case "image":
      return "files";
    case "shell":
      return "a command's output";
    case "agent.spawn":
    case "agent.message":
      return "another agent's output";
    default:
      return "a tool's output";
  }
}

function messageText(item: Extract<Item, { type: "message" }>): string {
  return item.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Follows one turn of a bot's hidden thread through its stored events and says what Spade sees:
 * the root agent's reply text as it streams, a status line, and one end. Pure: the service feeds
 * it every event of the thread after the turn was sent.
 */
export class BrainWatch {
  private readonly root: AgentId;
  private readonly provider: ProviderKind;
  /** The root agent's runs that started after the turn was sent. */
  private readonly runs = new Set<string>();
  /** Text already sent per assistant message, so a full copy only sends what is new. */
  private readonly sent = new Map<string, number>();
  private status: string | null = null;
  private usage = { input: 0, output: 0 };
  private readonly read = new Set<string>();
  ended = false;

  constructor(root: AgentId, provider: ProviderKind) {
    this.root = root;
    this.provider = provider;
  }

  /** Frames for one event, in order; none once the turn has ended. */
  next(payload: EventPayload): SpadeBrainFrame[] {
    if (this.ended) return [];
    switch (payload.type) {
      case "run.started":
        if (payload.run.agentId === this.root) this.runs.add(payload.run.id);
        return [];
      case "item.created":
      case "item.updated":
        return this.item(payload.item);
      case "item.delta": {
        if (payload.agentId !== this.root || payload.field !== "text") return [];
        const sent = this.sent.get(payload.itemId);
        if (sent === undefined) return [];
        this.sent.set(payload.itemId, sent + payload.append.length);
        return this.text(payload.append);
      }
      case "usage.updated":
        if (payload.agentId === this.root)
          this.usage = { input: payload.inputTokens, output: payload.outputTokens };
        return [];
      case "interaction.opened":
        return this.fail("needs_permission");
      case "run.ended": {
        if (!this.runs.has(payload.runId)) return [];
        if (payload.state === "completed") {
          this.ended = true;
          return [{ type: "finished", usage: this.usage }];
        }
        if (payload.state === "interrupted") return this.fail("failed", "The turn was stopped.");
        return this.fail(failureReason(payload.error));
      }
      default:
        return [];
    }
  }

  /** Ends the turn as failed; used for refusals and by the service when it gives up. */
  fail(reason: SpadeBrainFailure, message?: string): SpadeBrainFrame[] {
    if (this.ended) return [];
    this.ended = true;
    return [{ type: "failed", reason, message: message ?? failureLine(this.provider, reason) }];
  }

  private item(item: Item): SpadeBrainFrame[] {
    if (item.type === "tool_call") {
      const source = readSource(item);
      const read: SpadeBrainFrame[] =
        source && !this.read.has(source) ? [{ type: "read", source }] : [];
      if (source) this.read.add(source);
      // Any agent's call can bring outside text in; only the root's sets the status line.
      return item.agentId === this.root ? [...this.setStatus(toolStatus(item)), ...read] : read;
    }
    // Only the root agent's, and only what came after the turn was sent (the service feeds no
    // earlier event); providers may report a reply before the run that holds it.
    if (item.agentId !== this.root) return [];
    if (item.type !== "message" || item.role !== "assistant") return [];
    const full = messageText(item);
    const sent = this.sent.get(item.id) ?? 0;
    this.sent.set(item.id, Math.max(sent, full.length));
    return full.length > sent ? this.text(full.slice(sent)) : [];
  }

  private text(text: string): SpadeBrainFrame[] {
    if (!text) return [];
    return [...this.setStatus(null), { type: "text", text }];
  }

  private setStatus(status: string | null): SpadeBrainFrame[] {
    if (status === this.status) return [];
    this.status = status;
    return [{ type: "status", status }];
  }
}
