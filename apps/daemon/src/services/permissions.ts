import type { SocketContext, SocketService } from "./socket.ts";

/** Read-only preview. Registry metadata never starts a provider process. */
export function createPermissionsSession(context: SocketContext): SocketService {
  return {
    handle(message) {
      if (message.type !== "permissions.capabilities") return false;
      if (!context.authorize("read")) {
        context.fail("forbidden", "Read scope required", false, { requestId: message.requestId });
        return true;
      }
      try {
        const engine = context.options.engine;
        if (!engine) throw new Error("Permission metadata unavailable");
        const permissions = engine.capabilities(
          message.provider,
          message.provider === "cursor"
            ? "cursor-sdk"
            : message.backend === "cli"
              ? undefined
              : message.backend,
        ).permissions;
        context.send({
          type: "permissions.capabilities.result",
          requestId: message.requestId,
          ok: true,
          ...(permissions ? { permissions } : {}),
        });
      } catch {
        context.send({
          type: "permissions.capabilities.result",
          requestId: message.requestId,
          ok: false,
          error: "provider_unavailable",
        });
      }
      return true;
    },
  };
}
