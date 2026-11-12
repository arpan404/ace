import { ForgeLifecycleReceipt } from "./forge-lifecycle.ts";
import { ForgeIssueAction, ForgeIssueRef } from "./forge-issues.ts";
import { ForgeInboxAction } from "./forge-inbox.ts";
import { RepositoryPublication } from "./hosted-repositories.ts";
import { Project, ProjectInspection } from "./projects.ts";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { BackgroundTask } from "./background.ts";
import { Command } from "./commands.ts";
import { ContextMeter } from "./context-meter.ts";
import { DiagnosticsHealth } from "./diagnostics.ts";
import { Event, UsageUpdated } from "./events.ts";
import { ForgeStackOperation } from "./forge-stacks.ts";
import { ForgePrRef, ForgePrStatus } from "./forge.ts";
import { CommandId, DeviceId, HostId, InstallId, ThreadId } from "./ids.ts";
import { Interaction } from "./interactions.ts";
import { Item } from "./items.ts";
import { Capabilities } from "./provider.ts";
import { OmittedItem } from "./omitted-items.ts";
import { QueueState } from "./queue.ts";
import { ReviewData } from "./review.ts";
import { Run, Thread } from "./thread.ts";
import { ListAttention, ListedThreadPlace, ThreadListResume } from "./thread-place.ts";
import { EditorLaunch } from "./workspace-actions.ts";
import { MachineCode } from "./machine-access.ts";

/*
 * The stream every client needs from its first frame (ADR 0042): hello and welcome,
 * subscriptions with their snapshots, events and progress, commands and their results, item
 * pages and output reads. `wire.ts` adds the service families to make the full `ClientMessage`
 * and `ServerMessage`; a client can decode this core alone and load the rest when it needs them.
 */

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Zod records intentionally strip __proto__. Validate entries before rebuilding
// with own data properties so every supported opaque ID survives decoding.
const records = <T>(schema: z.ZodType<T>) =>
  z
    .custom<Record<string, unknown>>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (Object.getPrototypeOf(value) === null ||
          Object.getPrototypeOf(value) === Object.prototype),
    )
    .transform((value): unknown => Object.entries(value))
    .pipe(z.array(z.tuple([z.string(), schema])))
    .transform((entries) => Object.fromEntries<T>(entries))
    .meta({
      "x-ace-json-input": z.record(z.string(), schema),
      "x-ace-constraint":
        "Plain JSON object with every own opaque ID, including __proto__, validated and retained.",
    });
export const EntityCollection = z.enum(["agents", "runs", "interactions", "backgroundTasks"]);
export type EntityCollection = z.infer<typeof EntityCollection>;
export const ThreadView = z.object({
  /** Exclusive entity creation cursors. Active entities remain in every snapshot. */
  entitiesBefore: z.partialRecord(EntityCollection, seq.positive().nullable()).optional(),
  queue: QueueState.optional(),
  contextMeters: records(ContextMeter).optional(),
  kind: z.literal("thread"),
  seq,
  thread: Thread,
  agents: records(Agent),
  agentChildren: records(z.array(z.string())),
  runs: records(Run),
  items: records(Item),
  itemOrder: z.array(z.string()),
  /** Creation cursors for the bounded item window, independent of live update sequence. */
  itemSeqs: records(seq.positive()).optional(),
  /** Exclusive item creation-sequence cursor for older history. */
  itemsBefore: seq.positive().nullable().default(null),
  interactions: records(Interaction),
  backgroundTasks: records(BackgroundTask),
  usage: records(UsageUpdated),
  /** Inclusive snapshots are independent of per-agent activity. */
  usageSnapshots: records(UsageUpdated).default({}),
});
export type ThreadView = z.infer<typeof ThreadView>;
export const ThreadListEntry = Thread.omit({ rootAgentId: true }).extend({
  /**
   * Where the daemon puts the thread in the Threads panel. Absent from older daemons, and from
   * archived or unlisted threads; one this client can't read is dropped, not fatal.
   */
  place: ListedThreadPlace.optional(),
});
export type ThreadListEntry = z.infer<typeof ThreadListEntry>;
export const ThreadListCursor = z.object({ at: z.number().int().nonnegative(), id: ThreadId });
export type ThreadListCursor = z.infer<typeof ThreadListCursor>;
export const ThreadListWindow = z.object({
  before: ThreadListCursor.nullable(),
  total: z.number().int().nonnegative(),
  counts: z.array(z.object({ id: z.string(), threads: z.number().int().nonnegative() })),
  /** The newest thread row revision this list reflects (`ThreadListResume`). */
  revision: seq.optional(),
  /** The database and placement settings the list was read under (`ThreadListResume`). */
  epoch: z.string().min(1).max(256).optional(),
  /** The rail dots for what this list places live; absent from older daemons. */
  attention: ListAttention.optional(),
});
export type ThreadListWindow = z.infer<typeof ThreadListWindow>;
export const ThreadListView = z.object({
  window: ThreadListWindow.optional(),
  kind: z.literal("threads"),
  seq,
  threads: records(ThreadListEntry),
  /**
   * Answering a `resume`: threads unchanged since the client's revision, which it keeps from
   * the copy it holds. `threads` then holds only what changed. A kept id the client doesn't
   * hold means it must subscribe again without `resume`.
   */
  keep: z.array(ThreadId).optional(),
});
export type ThreadListView = z.infer<typeof ThreadListView>;
export const SnapshotView = z.discriminatedUnion("kind", [ThreadView, ThreadListView]);
export const SubscriptionScope = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threads"),
    window: z
      .object({
        limit: z.number().int().min(1).max(20),
        project: z.string().min(1).optional(),
        archived: z.boolean().optional(),
        /** Skip threads the client already holds unchanged; ignored by older daemons. */
        resume: ThreadListResume.optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
]);
export type SubscriptionScope = z.infer<typeof SubscriptionScope>;

/** First covered sequence when consecutive deltas have been concatenated in transit. */
export const DeliveryEvent = Event.extend({ seq, firstSeq: seq.positive().optional() })
  .refine(
    (event) =>
      event.firstSeq === undefined ||
      (event.payload.type === "item.delta" && event.firstSeq <= event.seq),
  )
  .meta({ "x-ace-constraint": "firstSeq is allowed only on item.delta and must be <= seq." });
export type DeliveryEvent = z.infer<typeof DeliveryEvent>;
export const ItemsPage = z.object({
  seq,
  threadId: ThreadId,
  items: z.array(Item).max(200),
  itemSeqs: records(seq.positive()).optional(),
  itemsBefore: seq.positive().nullable(),
  /** Items too large for one page, shown reduced or only summarized; paging continues past them. */
  omitted: z.array(OmittedItem).max(200).optional(),
});
export type ItemsPage = z.infer<typeof ItemsPage>;
export const EntitiesPage = z
  .discriminatedUnion("collection", [
    z.object({ collection: z.literal("agents"), entries: z.array(Agent).max(200) }),
    z.object({ collection: z.literal("runs"), entries: z.array(Run).max(200) }),
    z.object({ collection: z.literal("interactions"), entries: z.array(Interaction).max(200) }),
    z.object({
      collection: z.literal("backgroundTasks"),
      entries: z.array(BackgroundTask).max(200),
    }),
  ])
  .and(z.object({ seq, threadId: ThreadId, entitiesBefore: seq.positive().nullable() }));
export type EntitiesPage = z.infer<typeof EntitiesPage>;
export const CommandResult = z.object({
  issue: ForgeIssueRef.optional(),
  issueAction: ForgeIssueAction.optional(),
  inboxAction: ForgeInboxAction.optional(),
  publication: RepositoryPublication.optional(),
  workspace: Project.optional(),
  inspection: ProjectInspection.optional(),
  threadId: ThreadId.optional(),
  commandId: CommandId,
  ok: z.boolean(),
  forkThreadId: ThreadId.optional(),
  health: DiagnosticsHealth.optional(),
  error: z.string().optional(),
  /** Live ownership that prevents a plain delete or move. */
  alive: z
    .object({
      agentsRunning: z.number().int().nonnegative(),
      terminalsOpen: z.number().int().nonnegative(),
      operationsRunning: z.number().int().nonnegative(),
    })
    .optional(),
  /** Readable execution/admission failure, preserving the legacy error field. */
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  review: ReviewData.optional(),
  pr: ForgePrRef.optional(),
  prStatus: ForgePrStatus.optional(),
  forgeLifecycle: ForgeLifecycleReceipt.optional(),
  stackOperation: ForgeStackOperation.optional(),
  editor: EditorLaunch.optional(),
  terminalId: z.string().min(1).max(128).optional(),
  /** "Clear stale lock": how many stale Git locks it actually retired. */
  locksCleared: z.number().int().nonnegative().optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  /** A `git_push_rejected` push's remote-tracking revision: the lease for a force push. */
  remoteHead: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  /** `forge.pr.create` linked the branch's existing pull request instead of opening one. */
  prExisting: z.boolean().optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
/**
 * What the daemon knows of a command a client still waits on: `running` while it executes,
 * `settled` once its receipt has been sent again ahead of the reply, `unknown` when the daemon
 * has no record of it and isn't running it (a restart dropped it, or it ended without a result).
 */
export const CommandStatusState = z.enum(["running", "settled", "unknown"]);
export type CommandStatusState = z.infer<typeof CommandStatusState>;
/** A paired credential's proof, carried by an account hello of the same install (ADR 0115). */
export const PairingLinkProof = z.object({
  deviceId: DeviceId,
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PairingLinkProof = z.infer<typeof PairingLinkProof>;
/** The core client messages, in the order the full `ClientMessage` lists them. */
export const CoreClientMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      channel: z.enum(["files", "devices", "browser", "screen", "provider_auth"]).optional(),
      protocolVersion: z.literal(1),
      deviceId: DeviceId,
      token: z.string().optional(),
      ticket: z.string().optional(),
      /**
       * A device grant from the ace account backend (ADR 0111): admin on a machine signed in to
       * the same account, when the device id matches the grant.
       */
      grant: z.string().min(1).max(2048).optional(),
      /** The machine code, with a grant, when the daemon asked for it. */
      machineCode: MachineCode.optional(),
      /**
       * The app install this device runs in (ADR 0115). A paired device's record learns it, so
       * older records of the same install fold into one. Older daemons ignore it.
       */
      installId: InstallId.optional(),
      /**
       * With a grant: proof that this account device also holds a paired credential here (ADR
       * 0115), so the two ids are one device for command receipts. `proof` is the base64url
       * HMAC-SHA256 of `ace-link/v1\n<deviceId>\n<hello deviceId>`, keyed by the lowercase hex
       * SHA-256 of the paired token. Naming an install id links nothing; only this does.
       */
      link: PairingLinkProof.optional(),
      /**
       * Message compression this client can undo on a relayed channel: `deflate-raw` lets the
       * daemon deflate bulk JSON messages, each alone, before encrypting them. Unknown names
       * are ignored.
       */
      compression: z.array(z.string().max(32)).max(8).optional(),
      /**
       * Flow control this client takes part in on a relayed channel: `credit` lets the daemon
       * turn on credit fragments, so each end sends at most a window the other has consumed and
       * a slow reader holds back the sender instead of filling the relay (ADR 0110). Unknown
       * names are ignored.
       */
      flowControl: z.array(z.string().max(32)).max(8).optional(),
      /**
       * Redundant bytes this client can put back, so the daemon may leave them out of snapshots
       * and pages: `item-defaults` (items without `complete`, `synthetic` or `raw` when they hold
       * their defaults), `provider-capabilities` (threads that name their capabilities by a key
       * sent once in `provider.capabilities`), `spade-hidden` (accepts the hidden Spade
       * error code and live-end reason). Unknown names are ignored; without a name the
       * daemon sends the full shape.
       */
      trims: z.array(z.string().max(32)).max(16).optional(),
      /**
       * Frame packing this client can undo: `lines` lets the daemon put several server messages
       * in one text frame, each one's JSON on its own line (joined by `\n`, which JSON text
       * never holds raw), in the order they were sent. Unknown names are ignored; without
       * `lines` every frame holds exactly one message.
       */
      framing: z.array(z.string().max(32)).max(8).optional(),
    })
    .refine(
      (hello) =>
        [hello.token, hello.ticket, hello.grant].filter((value) => value !== undefined).length ===
        1,
      { message: "Exactly one credential is required" },
    )
    .refine((hello) => hello.machineCode === undefined || hello.grant !== undefined, {
      message: "A machine code goes with a grant",
    })
    .refine((hello) => hello.link === undefined || hello.grant !== undefined, {
      message: "A pairing link goes with a grant",
    })
    .meta({
      "x-ace-constraint":
        "Exactly one of token, ticket and grant is required; machineCode and link only with grant.",
    }),
  z.object({
    type: z.literal("subscribe"),
    subscriptionId: z.string().min(1),
    scope: SubscriptionScope,
    /** Request an explicit completion acknowledgement for paced resubscription. */
    paced: z.boolean().optional(),
    afterSeq: seq.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), subscriptionId: z.string().min(1) }),
  z.object({ type: z.literal("command"), command: Command }),
  z.object({
    type: z.literal("output.read"),
    requestId: z.string().min(1),
    streamId: z.string().min(1),
    offset: seq,
    limit: seq.positive().max(256 * 1024),
  }),
  z.object({
    type: z.literal("items.page"),
    requestId: z.string().min(1),
    threadId: ThreadId,
    before: seq.positive(),
    limit: seq.positive().max(200),
  }),
  z.object({
    type: z.literal("entities.page"),
    requestId: z.string().min(1),
    threadId: ThreadId,
    collection: EntityCollection,
    before: seq.positive(),
    limit: seq.positive().max(200),
  }),
  z.object({
    type: z.literal("threads.page"),
    requestId: z.string().min(1),
    subscriptionId: z.string().min(1),
    before: ThreadListCursor,
  }),
  /** Asks after commands sent on this socket that have no receipt yet; answered in order. */
  z.object({
    type: z.literal("command.status"),
    requestId: z.string().min(1),
    commandIds: z.array(CommandId).min(1).max(64),
  }),
  z.object({ type: z.literal("ping") }),
  /**
   * A fresh ace account device grant for this socket (ADR 0111, ADR 0114): an account socket
   * stays open only while it holds an unexpired grant, so the client sends a new one before
   * `welcome.grantTtlMs` runs out. Checked like the hello's grant; answered with
   * `account.grant.refresh.result`.
   */
  z.object({
    type: z.literal("account.grant.refresh"),
    requestId: z.string().min(1).max(128),
    grant: z.string().min(1).max(2048),
  }),
]);
export type CoreClientMessage = z.infer<typeof CoreClientMessage>;
/** The core server messages, in the order the full `ServerMessage` lists them. */
export const CoreServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("starting") }),
  /**
   * One provider's capabilities, under a key that threads on this connection name in
   * `capabilitiesRef`. Sent before the first message that uses the key, only to a connection
   * whose hello asked for the `provider-capabilities` trim.
   */
  z.object({
    type: z.literal("provider.capabilities"),
    key: z.string().min(1).max(64),
    capabilities: Capabilities,
  }),
  z.object({
    type: z.literal("threads.patch"),
    subscriptionId: z.string(),
    requestId: z.string().optional(),
    seq,
    threads: records(ThreadListEntry),
    removed: z.array(ThreadId),
    window: ThreadListWindow,
  }),
  z.object({
    type: z.literal("entities.page.part"),
    requestId: z.string().min(1),
    threadId: ThreadId,
    seq,
    index: seq,
    done: z.boolean(),
    data: z.string().max(131072),
  }),
  z.object({ type: z.literal("subscription.ready"), subscriptionId: z.string().min(1), seq }),
  z.object({
    type: z.literal("snapshot.part"),
    subscriptionId: z.string().min(1),
    seq,
    index: seq,
    done: z.boolean(),
    data: z.string().max(131072),
  }),
  z.object({ type: z.literal("entities.page"), requestId: z.string().min(1), page: EntitiesPage }),
  z.object({
    type: z.literal("welcome"),
    hostId: HostId,
    protocolVersion: z.literal(1),
    headSeq: seq,
    /**
     * For an ace account device: how long this socket's grant has left, in milliseconds. The
     * daemon closes the socket (4014) soon after unless `account.grant.refresh` brings a fresh
     * one. Absent for other credentials and from daemons that don't enforce it.
     */
    grantTtlMs: z.number().int().nonnegative().optional(),
  }),
  z
    .object({ type: z.literal("snapshot"), subscriptionId: z.string(), seq, view: SnapshotView })
    .refine((message) => message.seq === message.view.seq, {
      message: "Snapshot cursor must match view cursor",
    })
    .refine(
      ({ view }) =>
        view.kind !== "thread" ||
        view.itemOrder.every(
          (id) => view.itemSeqs !== undefined && Object.hasOwn(view.itemSeqs, id),
        ),
      { message: "Every snapshot item needs its creation sequence" },
    )
    .meta({
      "x-ace-constraint":
        "seq must equal view.seq; a thread view's itemSeqs holds the creation sequence of every item in itemOrder.",
    }),
  z
    .object({
      type: z.literal("events"),
      subscriptionId: z.string(),
      afterSeq: seq,
      throughSeq: seq,
      events: z.array(DeliveryEvent),
    })
    .refine(
      (message) => {
        let previous = message.afterSeq;
        if (message.throughSeq < previous) return false;
        for (const event of message.events) {
          if ((event.firstSeq ?? event.seq) <= previous || event.seq > message.throughSeq)
            return false;
          previous = event.seq;
        }
        return true;
      },
      { message: "Events must be ordered inside the declared coverage interval" },
    )
    .meta({
      "x-ace-constraint":
        "throughSeq >= afterSeq; events are ordered with (firstSeq ?? seq) > previous seq and seq <= throughSeq.",
    }),
  z
    .object({
      type: z.literal("progress"),
      subscriptionId: z.string(),
      afterSeq: seq,
      throughSeq: seq,
    })
    .refine((message) => message.throughSeq >= message.afterSeq, {
      message: "Progress must not move backwards",
    })
    .meta({ "x-ace-constraint": "throughSeq must be >= afterSeq." }),
  CommandResult.extend({ type: z.literal("commandResult") }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    subscriptionId: z.string().optional(),
    /** A refused command. The intent stays pending when `retryable`, and fails otherwise. */
    commandId: CommandId.optional(),
    retryable: z.boolean().optional(),
    /** With `machine_code_locked`: when code entry opens again (epoch milliseconds). */
    lockedUntil: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("output.data"),
    requestId: z.string(),
    streamId: z.string(),
    offset: seq,
    nextOffset: seq,
    bytes: z.string(),
    eof: z.boolean(),
  }),
  ItemsPage.extend({ type: z.literal("items.page"), requestId: z.string() })
    .refine(
      (page) =>
        page.items.every(
          (item) => page.itemSeqs !== undefined && Object.hasOwn(page.itemSeqs, item.id),
        ),
      { message: "Every page item needs its creation sequence" },
    )
    .meta({ "x-ace-constraint": "itemSeqs holds the creation sequence of every item." }),
  z.object({
    type: z.literal("command.status"),
    requestId: z.string(),
    commands: z.array(z.object({ commandId: CommandId, state: CommandStatusState })),
  }),
  z.object({ type: z.literal("pong") }),
  /** The answer to `account.grant.refresh`: how long the socket's grant now has, or why not. */
  z.object({
    type: z.literal("account.grant.refresh.result"),
    requestId: z.string(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), grantTtlMs: z.number().int().nonnegative() }),
      z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(256) }),
    ]),
  }),
]);
export type CoreServerMessage = z.infer<typeof CoreServerMessage>;
/** `type` of every core client message. */
export const coreClientTypes: ReadonlySet<string> = new Set([
  "hello",
  "subscribe",
  "unsubscribe",
  "command",
  "output.read",
  "items.page",
  "threads.page",
  "entities.page",
  "command.status",
  "ping",
  "account.grant.refresh",
]);
/** `type` of every core server message. */
export const coreServerTypes: ReadonlySet<string> = new Set([
  "starting",
  "provider.capabilities",
  "welcome",
  "threads.patch",
  "snapshot",
  "snapshot.part",
  "subscription.ready",
  "events",
  "progress",
  "commandResult",
  "error",
  "output.data",
  "items.page",
  "threads.page",
  "entities.page",
  "entities.page.part",
  "command.status",
  "pong",
  "account.grant.refresh.result",
]);
