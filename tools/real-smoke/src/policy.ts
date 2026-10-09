import { ClientMessage } from "@ace/protocol";

const reads = new Set([
  "hello",
  "subscribe",
  "unsubscribe",
  "ping",
  "output.read",
  "items.page",
  "entities.page",
  "turns.page",
  "items.window",
  "thread.search",
  "thread.catchUp",
  "thread.readState",
  "queue.get",
  "models.list",
  "models.resolve",
  "models.refresh",
  "providers.request",
  "settings.get",
  "settings.subscribe",
  "settings.unsubscribe",
  "catalog.list",
  "catalog.unsubscribe",
  "commands.list",
  "commands.resolve",
  "history.list",
  "history.scan",
  "history.import",
  "usage.summary",
  "usage.series",
  "usage.session_totals",
  "provider.accounts.list",
  "accounts.list",
  "accounts.status",
  "registry.list",
  "host.identity",
  "machines.request",
  "activity.reads",
  "activity.markRead",
  "automation.list",
  "automation.inbox",
  "permissions.capabilities",
  "diagnostics.health",
  "diagnostics.request",
  "mcp.provider.list",
  "mcp.provider.sources",
  "prompts.request",
  "context.request",
  "workspace.request",
  "projects.request",
  "onboarding.query",
  "notification.config",
  "notification.preferences",
  "pluginRequest",
  "presence.update",
  "screen.request",
  "worktree.creation.request",
]);

/** Default deny, including all durable commands and every future protocol addition. */
export function smokeMessage(raw: unknown): ClientMessage {
  const message = ClientMessage.parse(raw);
  if (message.type === "command") {
    if (["thread.markRead", "thread.read", "preview.list"].includes(message.command.payload.type))
      return message;
    throw new Error("Smoke refuses provider and workspace commands");
  }
  if (message.type === "screen.request" && !["status", "sessions"].includes(message.operation.op))
    throw new Error("Smoke refuses screen control");
  if (
    message.type === "pluginRequest" &&
    !["plugins.list", "plugins.catalog", "plugins.origins"].includes(message.request.type)
  )
    throw new Error("Smoke refuses plugin changes and repository access");
  if (message.type === "worktree.creation.request" && message.action !== "get")
    throw new Error("Smoke refuses worktree changes");
  if (message.type === "prompts.request" && message.operation.op === "write")
    throw new Error("Smoke refuses prompt edits");
  if (
    message.type === "context.request" &&
    !["draft.create", "draft.release", "attachment.list", "attachment.read"].includes(
      message.operation.op,
    )
  )
    throw new Error("Smoke refuses context changes");
  if (message.type === "projects.request" && message.operation.op !== "fs.home")
    throw new Error("Smoke refuses project filesystem access");
  if (!reads.has(message.type)) throw new Error(`Smoke refuses ${message.type}`);
  return message;
}
