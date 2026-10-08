import type { z } from "zod";
import type { ServerMessage, ClientMessage } from "@ace/protocol";
import { ClientError } from "./types.ts";

type Correlated<T = z.input<typeof ClientMessage>> = T extends unknown
  ? "requestId" extends keyof T
    ? T
    : never
  : never;
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type ServiceRequest = WithoutId<Exclude<Correlated, { type: "browser.ack" }>>;
type Reply = Extract<ServerMessage, { requestId?: string | undefined }>;
type Replies<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

// #72 adds queue schemas to the canonical union. Keep only correlation here;
// queue storage, removal, context leases and recovery remain with that owner.
export type ServiceResponse<Q extends ServiceRequest> = Q["type"] extends
  | `provider.login.${string}`
  | "provider.logout"
  ? Replies<"provider.login.result">
  : Q["type"] extends `onboarding.${string}`
    ? Replies<"onboarding.result">
    : LegacyServiceResponse<Q>;

type LegacyServiceResponse<Q extends ServiceRequest> = Q["type"] extends "host.identity"
  ? Replies<"host.identity.result">
  : Q["type"] extends "activity.reads" | "activity.markRead"
    ? Replies<"activity.reads.result">
    : Q["type"] extends "entities.page"
      ? Replies<"entities.page">
      : Q["type"] extends "queue.get"
        ? Extract<Reply, { type: "queue.result" }>
        : Q["type"] extends "permissions.capabilities"
          ? Replies<"permissions.capabilities.result">
          : Q["type"] extends "providers.request"
            ? Replies<"providers.result">
            : Q["type"] extends "projects.request"
              ? Replies<"projects.result">
              : Q["type"] extends "accounts.login" | "accounts.logout"
                ? Replies<"accounts.auth">
                : Q["type"] extends
                      | "accounts.add"
                      | "accounts.rename"
                      | "accounts.remove"
                      | "accounts.setDefault"
                  ? Replies<"accounts.changed">
                  : ExistingServiceResponse<Q>;

type ExistingServiceResponse<Q extends ServiceRequest> = Q["type"] extends
  | "turns.page"
  | "items.window"
  | "thread.search"
  | "thread.catchUp"
  | "thread.readState"
  ? Extract<Reply, { type: Q["type"] }>
  : Q["type"] extends "machines.request"
    ? Replies<"machines.result">
    : Q["type"] extends "files.pull"
      ? Replies<"files.data" | "files.error">
      : Q["type"] extends "files.chunk"
        ? Replies<"files.upload" | "files.error">
        : Q["type"] extends "history.list" | "history.scan" | "history.import" | "history.continue"
          ? Extract<Reply, { type: Q["type"] }>
          : Q["type"] extends "devices.request"
            ? Replies<"devices.result">
            : Q["type"] extends "pi.control"
              ? Replies<"pi.result">
              : Q["type"] extends "preview.request"
                ? Replies<"preview.result">
                : Q["type"] extends `automation.${string}`
                  ? Replies<"automation.result">
                  : Q["type"] extends "terminal.request"
                    ? Replies<"terminal.result">
                    : Q["type"] extends "workspace.request"
                      ? Replies<"workspace.result">
                      : Q["type"] extends "context.request"
                        ? Replies<"context.result">
                        : Q["type"] extends `models.${string}`
                          ? Replies<"models.result">
                          : Q["type"] extends `settings.${string}`
                            ? Replies<"settings.result">
                            : Q["type"] extends "usage.session_totals"
                              ? Replies<"usage.session_totals.result">
                              : Q["type"] extends `usage.${string}`
                                ? Replies<"usage.result">
                                : Q["type"] extends "search.query"
                                  ? Replies<"search.results" | "search.error">
                                  : Q["type"] extends "search.status"
                                    ? Replies<"search.progress" | "search.error">
                                    : Q["type"] extends `accounts.${string}`
                                      ? Extract<Reply, { type: Q["type"] }>
                                      : Q["type"] extends "files.request"
                                        ? Replies<
                                            | "files.result"
                                            | "files.ready"
                                            | "files.error"
                                            | "files.upload"
                                          >
                                        : Q["type"] extends "commands.list"
                                          ? Replies<"commands.list.result">
                                          : Q["type"] extends "commands.resolve"
                                            ? Replies<"commands.resolve.result">
                                            : Q["type"] extends `registry.${string}`
                                              ? Replies<"registry.result">
                                              : Q["type"] extends `mcp.${string}`
                                                ? Replies<"mcp.result">
                                                : Q["type"] extends "pluginRequest"
                                                  ? Replies<"pluginResult">
                                                  : Q["type"] extends `browser.${string}`
                                                    ? Replies<"browser.result">
                                                    : Q["type"] extends "screen.request"
                                                      ? Replies<"screen.result">
                                                      : Q["type"] extends "diagnostics.health"
                                                        ? Replies<"diagnostics.health.result">
                                                        : Q["type"] extends "items.page"
                                                          ? Replies<"items.page">
                                                          : Q["type"] extends "output.read"
                                                            ? Replies<"output.data">
                                                            : Reply;

const replyTypes: Partial<Record<ServiceRequest["type"], readonly ServerMessage["type"][]>> = {
  "host.identity": ["host.identity.result"],
  "activity.reads": ["activity.reads.result"],
  "activity.markRead": ["activity.reads.result"],
  "turns.page": ["turns.page"],
  "items.window": ["items.window"],
  "thread.search": ["thread.search"],
  "thread.catchUp": ["thread.catchUp"],
  "thread.readState": ["thread.readState"],
  "permissions.capabilities": ["permissions.capabilities.result"],
  "machines.request": ["machines.result"],
  "pi.control": ["pi.result"],
  "history.list": ["history.list"],
  "history.scan": ["history.scan"],
  "history.import": ["history.import"],
  "history.continue": ["history.continue"],
  "devices.request": ["devices.result"],
  "preview.request": ["preview.result"],
  "terminal.request": ["terminal.result"],
  "workspace.request": ["workspace.result"],
  "projects.request": ["projects.result"],
  "providers.request": ["providers.result"],
  "provider.login.start": ["provider.login.result"],
  "provider.login.poll": ["provider.login.result"],
  "provider.login.input": ["provider.login.result"],
  "provider.login.cancel": ["provider.login.result"],
  "provider.login.terminal": ["provider.login.result"],
  "provider.logout": ["provider.login.result"],
  "onboarding.query": ["onboarding.result"],
  "onboarding.dismiss": ["onboarding.result"],
  "context.request": ["context.result"],
  "models.list": ["models.result"],
  "models.refresh": ["models.result"],
  "models.resolve": ["models.result"],
  "settings.get": ["settings.result"],
  "settings.set": ["settings.result"],
  "settings.subscribe": ["settings.result"],
  "settings.unsubscribe": ["settings.result"],
  "usage.summary": ["usage.result"],
  "usage.series": ["usage.result"],
  "usage.session_totals": ["usage.session_totals.result"],
  "search.query": ["search.results", "search.error"],
  "search.status": ["search.progress", "search.error"],
  "accounts.add": ["accounts.changed"],
  "accounts.rename": ["accounts.changed"],
  "accounts.remove": ["accounts.changed"],
  "accounts.setDefault": ["accounts.changed"],
  "accounts.login": ["accounts.auth"],
  "accounts.logout": ["accounts.auth"],
  "accounts.list": ["accounts.list"],
  "accounts.status": ["accounts.status"],
  "accounts.migrate": ["accounts.migrate"],
  "files.pull": ["files.data", "files.error"],
  "files.chunk": ["files.upload", "files.error"],
  "files.request": ["files.result", "files.ready", "files.error", "files.upload"],
  "commands.list": ["commands.list.result"],
  "commands.resolve": ["commands.resolve.result"],
  pluginRequest: ["pluginResult"],
  "diagnostics.health": ["diagnostics.health.result"],
  "screen.request": ["screen.result"],
  "items.page": ["items.page"],
  "entities.page": ["entities.page"],
  "output.read": ["output.data"],
};
function isServiceResponse<Q extends ServiceRequest>(
  query: Q,
  id: string,
  response: ServerMessage,
): response is ServiceResponse<Q> {
  const types: readonly string[] =
    replyTypes[query.type] ??
    (query.type.startsWith("automation.")
      ? ["automation.result"]
      : query.type.startsWith("queue.")
        ? ["queue.result"]
        : query.type.startsWith("registry.")
          ? ["registry.result"]
          : query.type.startsWith("mcp.")
            ? ["mcp.result"]
            : query.type.startsWith("browser.")
              ? ["browser.result"]
              : []);
  return "requestId" in response && response.requestId === id && types.includes(response.type);
}
/** `schema` is the full `ServerMessage`, which the client loads with the service families. */
export function decodeServiceResponse<Q extends ServiceRequest>(
  schema: { parse(value: unknown): ServerMessage },
  query: Q,
  id: string,
  value: unknown,
): ServiceResponse<Q> {
  const response = schema.parse(value);
  if (
    query.type === "entities.page" &&
    response.type === "entities.page" &&
    (response.page.threadId !== query.threadId || response.page.collection !== query.collection)
  )
    throw new ClientError("protocol", "Unexpected entity page owner");
  if (!isServiceResponse(query, id, response))
    throw new ClientError("protocol", "Unexpected service response");
  return response;
}
