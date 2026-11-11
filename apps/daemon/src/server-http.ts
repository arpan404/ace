import {
  createServer as httpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { MaintenanceGate } from "@ace/service";
import { accessHttp } from "./access-http.ts";
import { attachmentsHttp } from "./attachments-http.ts";
import { iconsHttp } from "./icons-http.ts";
import { machineCallsHttp } from "./machines/http.ts";
import { transfersHttp } from "./transfers/http.ts";
import { previewHttp } from "./preview-http.ts";
import type { DaemonPreview } from "./preview.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { ServerOptions } from "./server-options.ts";
import { webHttp } from "./web-http.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
/** `/mcp` (with or without a query) to the daemon's MCP handler; everything else to `next`. */
function mcpFirst(options: ServerOptions, next: Handler): Handler {
  return (request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const serve = options.mcp?.handleHttp;
    if (path === "/mcp" && serve) return serve(request, response);
    next(request, response);
  };
}

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
): { local: Server; remoteHttp(): ReturnType<typeof transfersHttp> } {
  // Outside MCP clients at the ts.net name (ADR 0122) come first; everything else is the
  // paired-device chain below.
  const outsideFirst =
    (next: ReturnType<typeof transfersHttp>): ReturnType<typeof transfersHttp> =>
    (request, response) => {
      if (options.externalMcp?.tailscale(request, response)) return;
      next(request, response);
    };
  const local = httpServer(
    // `<daemon-endpoint>/mcp` (contract, "Finding the daemon"): the same MCP handler as its own
    // listener, for clients such as Spade that know only the daemon's address. Loopback only.
    mcpFirst(
      options,
      webHttp(
        options.webRoot,
        attachmentsHttp(
          options,
          auth,
          false,
          iconsHttp(
            options,
            auth,
            false,
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
    ),
  );
  // Paired devices only: one chain for the static and the runtime-toggled TLS listener.
  const remoteHttp = () =>
    outsideFirst(
      transfersHttp(
        () => options.transferTarget,
        auth.deviceBearer.bind(auth),
        machineCallsHttp(
          () => options.machineCalls,
          auth.deviceBearer.bind(auth),
          webHttp(
            options.webRoot,
            attachmentsHttp(
              options,
              auth,
              true,
              iconsHttp(
                options,
                auth,
                true,
                previewHttp(
                  preview,
                  accessHttp({ ...access, authenticate: auth.deviceBearer.bind(auth) }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  return { local, remoteHttp };
}
