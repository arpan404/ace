import { z } from "zod";
import { DeviceId, InstallId, ThreadId } from "./ids.ts";
import { MachineCode } from "./machine-access.ts";
import { PairingLinkProof } from "./wire-core.ts";

/*
 * The one-round-trip relay handshake (ADR 0155, step 2). A client the daemon announced it to
 * opens the stream with Noise NK, and its first message carries `hello.early`: an allowlist,
 * not today's hello, because a recorder can replay a first message. Every field outside it (the
 * device token, a machine code, link proofs, the install id, a dedicated channel, the next
 * ticket, a media ticket, presence, read markers, commands) is refused here, and the ones a
 * client needs come in `hello.confirm`, which only the holder of the first message's ephemeral
 * key can send.
 */

/** The handshake name a daemon announces in its welcome when it takes NK (`relayHandshakes`). */
export const RELAY_NK_HANDSHAKE = "nk1";

/** At most this many thread subscribes, and sidebar windows, ride in a first message. */
export const EARLY_THREAD_SUBSCRIBES = 4;
export const EARLY_SIDEBAR_WINDOWS = 2;

const Names8 = z.array(z.string().max(32)).max(8).optional();
const Names16 = z.array(z.string().max(32)).max(16).optional();

/**
 * What an early subscribe may read, strict at every depth: a thread, or a sidebar window with
 * its limit, project and archived filter. A window's `resume` and any other field go in a
 * subscribe sent after the confirmation.
 */
export const EarlyScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), threadId: ThreadId }),
  z.strictObject({
    kind: z.literal("threads"),
    window: z.strictObject({
      limit: z.number().int().min(1).max(20),
      project: z.string().min(1).optional(),
      archived: z.boolean().optional(),
    }),
  }),
]);

/** A read subscribe, as the main socket takes it, with nothing more. */
export const EarlySubscribe = z.strictObject({
  subscriptionId: z.string().min(1).max(128),
  scope: EarlyScope,
  paced: z.boolean().optional(),
  afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  tail: z
    .strictObject({
      items: z.number().int().min(1).max(200),
      bytes: z
        .number()
        .int()
        .min(1024)
        .max(1024 * 1024),
    })
    .optional(),
});
export type EarlySubscribe = z.infer<typeof EarlySubscribe>;

export const HelloEarly = z
  .strictObject({
    type: z.literal("hello.early"),
    protocolVersion: z.literal(1),
    deviceId: DeviceId,
    /** A one-use ticket the daemon handed in its last welcome to this device. */
    ticket: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** The account device grant, as the relay upgrade already offered it. */
    grant: z.string().min(1).max(2048).optional(),
    /** With a grant: its standing grant (ADR 0190), as in a hello. */
    standing: z.string().min(1).max(2048).optional(),
    trims: Names16,
    framing: Names8,
    compression: Names8,
    flowControl: Names8,
    subscribes: z
      .array(EarlySubscribe)
      .max(EARLY_THREAD_SUBSCRIBES + EARLY_SIDEBAR_WINDOWS)
      .optional(),
  })
  .refine((hello) => (hello.ticket === undefined) !== (hello.grant === undefined), {
    message: "Exactly one of ticket and grant is required",
  })
  .refine((hello) => hello.standing === undefined || hello.grant !== undefined, {
    message: "A standing grant goes with a grant",
  })
  .refine(
    (hello) =>
      (hello.subscribes ?? []).filter((s) => s.scope.kind === "thread").length <=
        EARLY_THREAD_SUBSCRIBES &&
      (hello.subscribes ?? []).filter((s) => s.scope.kind === "threads").length <=
        EARLY_SIDEBAR_WINDOWS,
    { message: "At most 4 thread subscribes and 2 sidebar windows" },
  )
  .refine(
    (hello) =>
      new Set((hello.subscribes ?? []).map((s) => s.subscriptionId)).size ===
      (hello.subscribes ?? []).length,
    { message: "Subscription ids must be distinct" },
  )
  .meta({
    "x-ace-constraint":
      "Exactly one of ticket and grant; at most 4 thread subscribes and 2 sidebar windows, with distinct subscription ids.",
  });
export type HelloEarly = z.infer<typeof HelloEarly>;

/**
 * The client's first transport message after the daemon's NK answer: proof it holds the first
 * message's ephemeral key. It carries the hello fields that act on the device, which are run
 * only now: the install id (folding records), a link proof, the next ticket, a machine code.
 */
export const HelloConfirm = z
  .strictObject({
    type: z.literal("hello.confirm"),
    installId: InstallId.optional(),
    link: PairingLinkProof.optional(),
    nextTicket: z.literal(true).optional(),
    machineCode: MachineCode.optional(),
  })
  .meta({ "x-ace-constraint": "Sent once, as the first message after an NK answer." });
export type HelloConfirm = z.infer<typeof HelloConfirm>;

/** The threads a first message reads, for the daemon's budget checks. */
export function earlyThreads(hello: HelloEarly): ThreadId[] {
  return (hello.subscribes ?? []).flatMap((s) =>
    s.scope.kind === "thread" ? [s.scope.threadId] : [],
  );
}
