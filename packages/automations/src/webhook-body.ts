/*
 * A webhook's JSON body as prompt variables (ADR 0158, decision 7). Pure. Every limit refuses the
 * whole body: a run never starts on part of what the sender sent.
 */
import type { TriggerVariables } from "@ace/protocol";

export const webhookBodyLimits = {
  bytes: 64 * 1024,
  depth: 8,
  /** Every value counts, objects and arrays included. */
  nodes: 256,
  /** `TriggerVariables` holds 64 entries; `webhook.id` takes one. */
  leaves: 63,
  valueLength: 8192,
  nameLength: 128,
};
const segment = /^[A-Za-z0-9_]+$/;

export type WebhookBody =
  | { ok: true; variables: TriggerVariables }
  | { ok: false; error: "too_large" | "bad_body"; message: string };

const refuse = (message: string): WebhookBody => ({ ok: false, error: "bad_body", message });

export function webhookVariables(body: Uint8Array, deliveryId: string): WebhookBody {
  if (body.byteLength > webhookBodyLimits.bytes)
    return { ok: false, error: "too_large", message: "The body is over 64 KiB." };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return refuse("The body isn't JSON.");
  }
  if (!isObject(value)) return refuse("The body must be a JSON object.");
  const variables: Record<string, string> = { "webhook.id": deliveryId };
  let nodes = 0;
  let leaves = 0;
  // Iterative, so a deep body can't exhaust the stack before the depth check refuses it.
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value, path: "body", depth: 1 },
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    if (++nodes > webhookBodyLimits.nodes) return refuse("The body has more than 256 values.");
    if (next.path.length > webhookBodyLimits.nameLength)
      return refuse(`A field's path is over ${webhookBodyLimits.nameLength} characters.`);
    const children = entries(next.value);
    if (children) {
      if (next.depth > webhookBodyLimits.depth)
        return refuse("The body is nested more than 8 deep.");
      // Reversed onto the stack, so variables come out in the body's order.
      for (let i = children.length - 1; i >= 0; i--) {
        const [key, child] = children[i] ?? ["", undefined];
        if (!segment.test(key))
          return refuse(`The key "${key.slice(0, 64)}" isn't letters, digits and _.`);
        stack.push({ value: child, path: `${next.path}.${key}`, depth: next.depth + 1 });
      }
      continue;
    }
    if (++leaves > webhookBodyLimits.leaves)
      return refuse(`The body has more than ${webhookBodyLimits.leaves} fields.`);
    const text = typeof next.value === "string" ? next.value : JSON.stringify(next.value);
    if (text.length > webhookBodyLimits.valueLength)
      return refuse(`A field is over ${webhookBodyLimits.valueLength} characters.`);
    variables[next.path] = text;
  }
  return { ok: true, variables };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object's or array's entries, keyed by name or index; undefined for a leaf. */
function entries(value: unknown): [string, unknown][] | undefined {
  if (Array.isArray(value)) return value.map((child, index) => [String(index), child]);
  if (isObject(value)) return Object.entries(value);
  return undefined;
}
