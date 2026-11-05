import { z } from "zod";
import {
  ClientMessage,
  BrowserClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import type { SocketMessage } from "./socket.ts";

/** Every message family a socket accepts, in the order a message is matched against them. */
const families: readonly z.ZodType<SocketMessage>[] = [
  ClientMessage,
  PluginClientMessage,
  BrowserClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
];

/** The `type` literals a schema accepts, or undefined when it doesn't pin `type` down. */
function typeLiterals(schema: z.core.$ZodType): ReadonlySet<unknown> | undefined {
  if (schema instanceof z.ZodObject) {
    const type: unknown = schema.shape["type"];
    return type instanceof z.ZodLiteral ? type.values : undefined;
  }
  if (!(schema instanceof z.ZodUnion)) return undefined;
  const literals = new Set<unknown>();
  for (const option of schema.options) {
    const values = typeLiterals(option);
    if (!values) return undefined;
    for (const value of values) literals.add(value);
  }
  return literals;
}

/**
 * The families worth trying for each `type`, still in match order. A family that doesn't pin
 * `type` down is a candidate for every message, so the result matches trying all of them.
 */
const unpinned = families.filter((schema) => !typeLiterals(schema));
const candidatesByType = new Map<unknown, z.ZodType<SocketMessage>[]>();
for (const schema of families)
  for (const literal of typeLiterals(schema) ?? []) {
    const candidates = candidatesByType.get(literal) ?? [];
    candidates.push(schema);
    candidatesByType.set(literal, candidates);
  }
for (const [literal, candidates] of candidatesByType)
  candidatesByType.set(
    literal,
    families.filter((schema) => candidates.includes(schema) || unpinned.includes(schema)),
  );

export function parseSocketMessage(input: unknown): SocketMessage {
  const type = typeof input === "object" && input !== null ? Reflect.get(input, "type") : undefined;
  for (const schema of candidatesByType.get(type) ?? unpinned) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}

const RequestShape = z.object({ type: z.string(), requestId: z.string().optional() });

/**
 * A frame from a signed-in device: a message, a request whose type this daemon doesn't know
 * (a newer or older client's), or a frame that doesn't match the protocol. A known type with
 * bad fields is invalid, not unsupported; either answer carries the request id when it has one.
 */
export type DeviceFrame =
  | { kind: "message"; message: SocketMessage }
  | { kind: "unsupported"; requestId?: string }
  | { kind: "invalid"; requestId?: string };

export function decodeDeviceFrame(value: unknown): DeviceFrame {
  try {
    return { kind: "message", message: parseSocketMessage(value) };
  } catch {
    const shape = RequestShape.safeParse(value);
    if (!shape.success) return { kind: "invalid" };
    const kind = candidatesByType.has(shape.data.type) ? "invalid" : "unsupported";
    return shape.data.requestId ? { kind, requestId: shape.data.requestId } : { kind };
  }
}

/** Desktop backend `type`s no other message family accepts. */
const backendOnlyTypes: ReadonlySet<unknown> = new Set(
  [...(typeLiterals(BrowserBackendClientMessage) ?? [])].filter((literal) => {
    const candidates = candidatesByType.get(literal);
    return candidates?.length === 1 && candidates[0] === BrowserBackendClientMessage;
  }),
);

/**
 * The desktop backend message a parsed socket message is, if any. Messages arrive already parsed
 * by `parseSocketMessage`, so one whose `type` only the backend family accepts is used as is.
 */
export function browserBackendMessage(
  message: SocketMessage,
): BrowserBackendClientMessage | undefined {
  if (isBackendOnly(message)) return message;
  const parsed = BrowserBackendClientMessage.safeParse(message);
  return parsed.success ? parsed.data : undefined;
}

function isBackendOnly(message: SocketMessage): message is BrowserBackendClientMessage {
  return backendOnlyTypes.has(message.type);
}
