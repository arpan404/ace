import { z } from "zod";

/*
 * The only machine-call answers that may be compressed (ADR 0088), described exactly: every
 * object is strict, so an unknown key at any depth fails and the answer goes as it is, and every
 * string is a field named here as one that never carries a secret (an id, a name, a label, a
 * code, or text an agent wrote, which the socket compresses as transcript too). A field a newer
 * build adds anywhere leaves its answers uncompressed until it is added here. These are checks
 * on what this machine is about to send, not decoders: the protocol schemas decode.
 */

/** An id, a name, a label or a code: short, chosen by ace or the person, never a credential. */
const name = z.string().max(256);
/** Text an agent or ace wrote about the work: titles, steps, results, notices. */
const text = z.string().max(4096);
const count = z.number().int().nonnegative();

const threadStatus = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("needs_you"), interactions: count }),
  z.strictObject({ state: z.literal("working"), agents: count }),
  z.strictObject({
    state: z.literal("waiting"),
    on: z.enum(["background_task", "rate_limit", "network", "upstream", "queue"]),
    slotLimit: count.optional(),
    slotsInUse: count.optional(),
    queuePosition: count.optional(),
  }),
  z.strictObject({ state: z.literal("limited"), until: z.number().optional() }),
  z.strictObject({ state: z.literal("failed") }),
  z.strictObject({ state: z.literal("unresponsive") }),
  z.strictObject({ state: z.literal("done") }),
  z.strictObject({ state: z.literal("new") }),
]);

/**
 * One thread in a status answer. `requests` and `needs` only empty: a pending request for the
 * person can carry a URL with a code or token in it.
 */
const threadView = z.strictObject({
  threadId: name,
  state: z.enum(["working", "queued", "needs_you", "done", "failed", "cancelled"]),
  title: text,
  elapsedSeconds: count,
  step: text.optional(),
  result: text.optional(),
  truncated: z.boolean().optional(),
  last: text.optional(),
  machine: name.optional(),
  contact: z.enum(["lost", "unconfirmed"]).optional(),
  failure: z
    .strictObject({
      code: name,
      message: text,
      accountId: name.optional(),
      accountLabel: name.optional(),
      resetsAt: z.number().optional(),
    })
    .optional(),
  status: threadStatus,
  notice: z.strictObject({ text, commandId: name, code: name }).optional(),
  requests: z.array(z.never()).max(0).optional(),
  needs: z.array(z.never()).max(0).optional(),
});

export const CompressibleStatus = z.strictObject({ threads: z.array(threadView).max(16) });

const level = z.enum(["off", "read", "operate"]);
export const CompressibleDescription = z.strictObject({
  hostId: name,
  name,
  access: z.enum(["read", "operate"]),
  grants: z
    .strictObject({ agents: level, browser: level, devices: level, screen: level, commands: level })
    .optional(),
  projects: z.array(z.strictObject({ workspaceId: name, name })).max(32),
  tools: z.array(name).max(16),
  providers: z.array(name).max(16),
  transfers: z.boolean().optional(),
  delegateAccounts: z.boolean().optional(),
  accounts: z
    .array(z.strictObject({ provider: name, id: name, label: name.optional() }))
    .max(64)
    .optional(),
});
