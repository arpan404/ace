import { ServerMessage, type ClientMessage } from "@ace/protocol";
import type { z } from "zod";
import { ClientError } from "./types.ts";

/*
 * Correlated one-off service requests (ADR 0052). The same surface lands with
 * feat/client-protocol-gaps, which extends the table with the services it adds; on merge keep
 * that branch's copy.
 */
// Callers write the input shape; the client fills schema defaults when it parses the message.
type Correlated = Extract<z.input<typeof ClientMessage>, { requestId: string }>;
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never;
/** Every client message answered by a reply carrying the same request id. */
export type ServiceRequest = WithoutId<
  Exclude<Correlated, { type: "items.page" | "output.read" | `registry.${string}` }>
>;
type Replies<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export type ServiceResponse<Q extends ServiceRequest> = Q["type"] extends "context.request"
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
                ? Extract<ServerMessage, { type: Q["type"] }>
                : Q["type"] extends "files.request"
                  ? Replies<"files.result" | "files.ready" | "files.error" | "files.upload">
                  : Q["type"] extends "commands.list"
                    ? Replies<"commands.list.result">
                    : Q["type"] extends "commands.resolve"
                      ? Replies<"commands.resolve.result">
                      : Q["type"] extends `mcp.${string}`
                        ? Replies<"mcp.result">
                        : Q["type"] extends "screen.request"
                          ? Replies<"screen.result">
                          : never;

const replyTypes: Partial<Record<ServiceRequest["type"], readonly ServerMessage["type"][]>> = {
  "context.request": ["context.result"],
  "models.list": ["models.result"],
  "models.refresh": ["models.result"],
  "models.resolve": ["models.result"],
  "settings.get": ["settings.result"],
  "settings.set": ["settings.result"],
  "settings.subscribe": ["settings.result"],
  "usage.summary": ["usage.result"],
  "usage.series": ["usage.result"],
  "usage.session_totals": ["usage.session_totals.result"],
  "search.query": ["search.results", "search.error"],
  "search.status": ["search.progress", "search.error"],
  "accounts.list": ["accounts.list"],
  "accounts.status": ["accounts.status"],
  "accounts.migrate": ["accounts.migrate"],
  "files.request": ["files.result", "files.ready", "files.error", "files.upload"],
  "commands.list": ["commands.list.result"],
  "commands.resolve": ["commands.resolve.result"],
  "screen.request": ["screen.result"],
};

function expected(type: ServiceRequest["type"]): readonly string[] {
  const listed = replyTypes[type];
  if (listed) return listed;
  if (type.startsWith("mcp.")) return ["mcp.result"];
  return [];
}

function isServiceResponse<Q extends ServiceRequest>(
  query: Q,
  id: string,
  response: ServerMessage,
): response is ServiceResponse<Q> {
  return (
    "requestId" in response &&
    response.requestId === id &&
    expected(query.type).includes(response.type)
  );
}

/** Parse a correlated reply and check it answers this request; anything else is a protocol fault. */
export function decodeServiceResponse<Q extends ServiceRequest>(
  query: Q,
  id: string,
  value: unknown,
): ServiceResponse<Q> {
  const response = ServerMessage.parse(value);
  if (!isServiceResponse(query, id, response))
    throw new ClientError("protocol", "Unexpected service response");
  return response;
}
