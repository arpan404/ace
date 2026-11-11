import type { OutsideOperation, OutsideOutcome } from "@ace/protocol";
import type { OutsideAccess } from "../external-mcp/outside.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * `outside.request`: outside MCP clients' grants on this machine (ADR 0117), for an
 * administrator. Lists, revokes and changes grants, ends a client's screen work, and answers
 * sign-in requests. `watch` sends `outside.state` now and on every change. Replies never carry
 * a token.
 */
export function createOutsideClientsSession(context: SocketContext): SocketService {
  const stops: (() => void)[] = [];
  const outside = (): OutsideAccess | undefined => context.options.externalMcp?.outside;
  const push = () => {
    const owner = outside();
    if (!owner || !context.connected() || !context.authorize("admin")) return;
    context.send({
      type: "outside.state",
      access: owner.requests.current(),
      screen: owner.screen.current(),
    });
  };
  /** The admin device acting, or `local` for the host's own credential. */
  const by = () => (context.hostCredential?.() ? "local" : (context.device() ?? "local"));
  const run = (owner: OutsideAccess, operation: OutsideOperation): OutsideOutcome | string => {
    switch (operation.op) {
      case "grants":
        return { kind: "grants", grants: owner.grants.entries() };
      case "revoke":
        return owner.revoke(operation.grantId) ? { kind: "revoked" } : "not_found";
      case "update": {
        const grant = owner.update(operation.grantId, {
          ...(operation.scopes ? { scopes: operation.scopes } : {}),
          ...(operation.projects ? { projects: operation.projects } : {}),
          ...(operation.expiresAt !== undefined ? { expiresAt: operation.expiresAt } : {}),
        });
        return grant ? { kind: "updated", grant } : "not_found";
      }
      case "watch":
        if (!stops.length) stops.push(owner.requests.subscribe(push), owner.screen.subscribe(push));
        return { kind: "watching" };
      case "stopScreen":
        return owner.stopScreen(operation.grantId, by()) ? { kind: "screenStopped" } : "not_found";
      case "decide": {
        return owner.decide(operation.accessRequestId, operation.choice, by())
          ? { kind: "decided" }
          : "not_found";
      }
    }
  };
  return {
    close() {
      for (const stop of stops.splice(0)) stop();
    },
    handle(message) {
      if (message.type !== "outside.request") return false;
      const { requestId, operation } = message;
      if (!context.authorize("admin")) {
        context.fail(
          "forbidden",
          "Only an administrator can manage outside clients' access.",
          false,
          { requestId },
        );
        return true;
      }
      const owner = outside();
      if (!owner) {
        context.fail("unavailable", "Outside MCP clients aren't running here.", false, {
          requestId,
        });
        return true;
      }
      const result = run(owner, operation);
      if (typeof result === "string") {
        context.fail(result, "No such grant or request, or it already ended.", false, {
          requestId,
        });
        return true;
      }
      context.send({ type: "outside.result", requestId, result });
      if (operation.op === "watch") push();
      return true;
    },
  };
}
