import { ClientError, type Client, type RegistryQuery, type ServiceRequest } from "@ace/client";
import { CommandPayload, TextSource } from "@ace/protocol";
import { z } from "zod";

/*
 * Requests a tab makes of the worker's client, decoded at the port. The client validates each
 * request again on its way to the daemon, as it does for an in-process caller.
 */

const Options = z.object({ timeoutMs: z.number().positive().optional() }).optional();
const Read = z.object({
  streamId: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
const Page = z.object({
  threadId: z.string(),
  before: z.number().optional(),
  limit: z.number().int().positive(),
});
const RegistryInput = z.custom<RegistryQuery>(
  (value) => typeof value === "object" && value !== null && "type" in value,
);

// The client parses the whole request with the protocol schema before it is sent.
const ServiceInput = z.custom<ServiceRequest>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string",
);

const schemas = {
  enqueue: z.tuple([CommandPayload, z.string().optional()]),
  command: z.tuple([CommandPayload, Options, z.string().optional()]),
  registry: z.tuple([RegistryInput, Options]),
  itemsPage: z.tuple([Page, Options]),
  loadOlder: z.tuple([z.string(), z.number().int().positive(), Options]),
  outputRead: z.tuple([Read, Options]),
  networkOnline: z.tuple([z.boolean()]),
  request: z.tuple([ServiceInput, Options]),
};

const options = (parsed: { timeoutMs?: number | undefined } | undefined, signal: AbortSignal) =>
  parsed?.timeoutMs === undefined ? { signal } : { signal, timeoutMs: parsed.timeoutMs };

function decode<T extends z.ZodType>(schema: T, args: unknown[]): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new ClientError("protocol", "Invalid worker request");
  return parsed.data;
}

/** Run one request method of the worker's client with a tab's arguments. */
export async function callArgs(
  client: Client,
  method: string,
  args: unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  switch (method) {
    case "enqueue": {
      const [payload, id] = decode(schemas.enqueue, args);
      const sent = await client.enqueue(payload, id);
      return { id: sent, intent: client.intent(sent).getSnapshot() };
    }
    case "command": {
      const [payload, parsed, id] = decode(schemas.command, args);
      return client.command(payload, options(parsed, signal), id);
    }
    case "registry": {
      const [input, parsed] = decode(schemas.registry, args);
      return client.registry(input, options(parsed, signal));
    }
    case "itemsPage": {
      const [page, parsed] = decode(schemas.itemsPage, args);
      return client.itemsPage(page, options(parsed, signal));
    }
    case "loadOlder": {
      const [threadId, limit, parsed] = decode(schemas.loadOlder, args);
      return client.loadOlder(threadId, limit, options(parsed, signal));
    }
    case "outputRead": {
      const [read, parsed] = decode(schemas.outputRead, args);
      return client.outputRead(read, options(parsed, signal));
    }
    case "request": {
      const [input, parsed] = decode(schemas.request, args);
      return client.request(input, options(parsed, signal));
    }
    case "networkOnline": {
      const [online] = decode(schemas.networkOnline, args);
      client.networkOnline(online);
      return undefined;
    }
    default:
      throw new ClientError("protocol", "Unknown worker request");
  }
}

/** Start one of the client's streaming reads with a tab's arguments. */
export function iterateArgs(
  client: Client,
  method: string,
  args: unknown[],
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  if (method === "text") {
    const [source, parsed] = decode(z.tuple([TextSource, Options]), args);
    return client.text(source, options(parsed, signal));
  }
  if (method === "output") {
    const [read, parsed] = decode(z.tuple([Read, Options]), args);
    return client.output(read, options(parsed, signal));
  }
  throw new ClientError("protocol", "Unknown worker stream");
}
