import type { PreviewServer } from "../sources.ts";

/** "web · :5173", or ":5173" for a server without a name. */
export const portLabel = (server: Pick<PreviewServer, "port" | "name">) =>
  server.name ? `${server.name} · :${server.port}` : `:${server.port}`;

/** The workspace tab that previews one dev server (`port` kind, id: the port). */
export const portTab = (server: Pick<PreviewServer, "port" | "name">) => ({
  kind: "port",
  id: String(server.port),
  title: portLabel(server),
});
