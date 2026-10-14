import { piCapabilities } from "@ace/adapter-pi/capabilities";
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
        const base =
          message.provider === "pi"
            ? piCapabilities({ installed: false, auth: "unknown", loginHint: "" })
            : engine.capabilities(
                message.provider,
                message.provider === "cursor"
                  ? "cursor-sdk"
                  : message.backend === "cli"
                    ? undefined
                    : message.backend,
              );
        let permissions = base.permissions;
        const instance =
          message.instanceId &&
          context.options.models
            ?.list({
              provider: message.provider,
            })
            .instances.find(
              (row) => row.instance === message.instanceId || row.instanceId === message.instanceId,
            );
        if (instance && instance.permissionModes && permissions)
          permissions = {
            ...permissions,
            permissionModes: instance.permissionModes,
            modes: instance.permissionModes.map((mode) => mode.id),
          };
        const accessModes = (instance ? instance.accessModes : undefined) ?? base.accessModes;
        context.send({
          type: "permissions.capabilities.result",
          requestId: message.requestId,
          ok: true,
          ...(permissions ? { permissions } : {}),
          ...(accessModes ? { accessModes } : {}),
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
