import { z } from "zod";
import { object, string } from "./data.ts";
export const NativeEvent = z
  .object({
    id: z.string().max(512),
    type: z.string().max(256),
    data: z.record(z.string(), z.unknown()),
    location: z
      .object({ directory: z.string().max(4096) })
      .passthrough()
      .optional(),
    durable: z
      .object({
        aggregateID: z.string().max(512),
        seq: z.number().int().nonnegative(),
        version: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const SessionInfo = z
  .object({
    id: z.string().min(1).max(512),
    projectID: z.string().max(512),
    location: z.object({ directory: z.string().min(1).max(4096) }).passthrough(),
    parentID: z.string().max(512).optional(),
    fork: z.unknown().optional(),
  })
  .passthrough();
export const Page = z
  .object({
    data: z.array(z.unknown()).max(200),
    cursor: z.object({ previous: z.string().nullish(), next: z.string().nullish() }).passthrough(),
  })
  .passthrough();
export const PendingList = z.array(z.record(z.string(), z.unknown())).max(1024);
export const ProjectedMessage = z
  .object({
    id: z.string().min(1).max(512),
    type: z.string().max(256),
    content: z.array(z.unknown()).max(2048).optional(),
  })
  .passthrough();
export function eventSession(value: unknown): string {
  const e = object(value),
    p = object(e.data);
  return string(
    p.sessionID,
    string(object(p.form).sessionID, string(object(object(p.info).metadata).sessionID)),
  );
}
export function loopback(value: unknown): URL {
  const url = new URL(z.string().parse(value));
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("OpenCode requires a credential-free loopback HTTP URL");
  return url;
}
/** Conservatively support the inspected release only until another contract is reviewed. */
export function version(value: unknown): boolean {
  return value === "2.0.22";
}
export const requiredOperations = [
  "server.info",
  "event.subscribe",
  "session.create",
  "session.get",
  "session.switchModel",
  "session.list",
  "session.active",
  "session.prompt",
  "session.interrupt",
  "session.message.list",
  "session.permission.list",
  "session.permission.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.inbox.list",
  "shell.list",
  "shell.get",
  "shell.remove",
  "model.list",
];
export function validateSpec(value: unknown): void {
  const spec = z
    .object({
      openapi: z.string().startsWith("3."),
      paths: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .parse(value);
  const ops = new Set<string>();
  for (const path of Object.values(spec.paths))
    for (const method of Object.values(path)) {
      const op = object(method).operationId;
      if (typeof op === "string") ops.add(op);
    }
  if (requiredOperations.some((op) => !ops.has(op)))
    throw new Error("Incompatible OpenCode operation contract");
}
