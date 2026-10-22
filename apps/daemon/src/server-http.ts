import { createServer as httpServer, type Server } from "node:http";
import type { MaintenanceGate } from "@ace/service";
import { accessHttp } from "./access-http.ts";
import { attachmentsHttp } from "./attachments-http.ts";
import { iconsHttp } from "./icons-http.ts";
import { machineCallsHttp } from "./machines/http.ts";
import { previewHttp } from "./preview-http.ts";
import type { DaemonPreview } from "./preview.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { ServerOptions } from "./server-options.ts";
import { webHttp } from "./web-http.ts";

type Access = Omit<Parameters<typeof accessHttp>[0], "authenticate" | "maintenance" | "shutdown">;

/**
 * The daemon's HTTP request chains: the loopback server (host token, maintenance and stop
 * endpoints) and the handler for paired devices, shared by the static and the runtime-toggled
 * TLS listener.
 */
export function httpChains(
  options: ServerOptions,
  auth: RemoteAuth,
  access: Access,
  maintenance: MaintenanceGate,
  preview: () => DaemonPreview | undefined,
): { local: Server; remoteHttp(): ReturnType<typeof machineCallsHttp> } {
  const local = httpServer(
    webHttp(
      options.webRoot,
      attachmentsHttp(
        options,
        auth,
        false,
        access.allowedOrigins,
        iconsHttp(
          options,
          auth,
          false,
          access.allowedOrigins,
          previewHttp(
            preview,
            accessHttp({
              ...access,
              authenticate: auth.localBearer.bind(auth),
              maintenance,
              ...(options.shutdown ? { shutdown: options.shutdown } : {}),
            }),
          ),
        ),
      ),
    ),
  );
  // Paired devices only: one chain for the static and the runtime-toggled TLS listener.
  const remoteHttp = () =>
    machineCallsHttp(
      () => options.machineCalls,
      auth.deviceBearer.bind(auth),
      webHttp(
        options.webRoot,
        attachmentsHttp(
          options,
          auth,
          true,
          access.allowedOrigins,
          iconsHttp(
            options,
            auth,
            true,
            access.allowedOrigins,
            previewHttp(
              preview,
              accessHttp({ ...access, authenticate: auth.deviceBearer.bind(auth) }),
            ),
          ),
        ),
      ),
    );
  return { local, remoteHttp };
}
