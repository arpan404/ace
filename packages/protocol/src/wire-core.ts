import { ForgeLifecycleReceipt } from "./forge-lifecycle.ts";
import { ForgeIssueAction, ForgeIssueRef } from "./forge-issues.ts";
import { ForgeInboxAction } from "./forge-inbox.ts";
import { RepositoryPublication } from "./hosted-repositories.ts";
import { Project, ProjectInspection } from "./projects.ts";
import { z } from "zod";
import { MediaTicket } from "./media-connection.ts";
import { Agent } from "./agent.ts";
import { BackgroundTask } from "./background.ts";
import { Command } from "./commands.ts";
import { ContextMeter } from "./context-meter.ts";
import { DiagnosticsHealth } from "./diagnostics.ts";
import { Event, UsageUpdated } from "./events.ts";
import { ForgeStackOperation } from "./forge-stacks.ts";
import { ForgePrRef, ForgePrStatus } from "./forge.ts";
import { CommandId, DeviceId, HostId, InstallId, InteractionId, ThreadId } from "./ids.ts";
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
  /**
   * On a snapshot cut to a `tail` that holds less than a full snapshot would: it has older items
   * left, or `previews` names items it sent only as a bounded preview (a full snapshot carries
   * them whole). The client completes the thread by subscribing again with neither a cursor nor
   * a tail, and the full snapshot replaces this one.
   */
  partial: z.object({ previews: z.array(z.string().min(1)).max(200) }).optional(),
  interactions: records(Interaction),
  backgroundTasks: records(BackgroundTask),
  usage: records(UsageUpdated),
  /** Inclusive snapshots are independent of per-agent activity. */
  usageSnapshots: records(UsageUpdated).default({}),
});
export type ThreadView = z.infer<typeof ThreadView>;
/** One device's read cursor for a thread, as `thread.readState` answers it. */
export const ThreadReadCursor = z.object({
  lastSeenSeq: seq,
  /** When it was last moved; null while the device has never marked the thread read. */
  updatedAt: z.number().int().nonnegative().nullable(),
});
export type ThreadReadCursor = z.infer<typeof ThreadReadCursor>;
export const ThreadListEntry = Thread.omit({ rootAgentId: true }).extend({
  /**
   * Where the daemon puts the thread in the Threads panel. Absent from older daemons, and from
   * archived or unlisted threads; one this client can't read is dropped, not fatal.
   */
  place: ListedThreadPlace.optional(),
  /**
   * The subscribing device's read cursor for the thread, sent again whenever that device marks
   * it read. Absent from older daemons: the client asks with `thread.readState`.
   */
  readState: ThreadReadCursor.optional(),
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
  /** With `keep`: the subscribing device's read cursor for each kept thread that has one. */
  reads: records(ThreadReadCursor).optional(),
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
  .and(
    z.object({
      seq,
      threadId: ThreadId,
      entitiesBefore: seq.positive().nullable(),
      /**
       * Entities of this page too large for any reply (over 32 MiB of JSON), each named in its
       * place: never dropped, so a reader can say one waits that it cannot show.
       */
      tooLarge: z
        .array(
          z.object({
            id: z.string(),
            /** An interaction's request kind. */
            kind: z.string().optional(),
            /** Pending, working or running, as the page's active entities are. */
            active: z.boolean(),
            bytes: seq,
          }),
        )
        .max(200)
        .optional(),
    }),
  );
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
      channel: z
        .enum(["files", "devices", "browser", "screen", "provider_auth", "media", "machine"])
        .optional(),
      /**
       * With `channel: "media"` on a relay stream with the `media` purpose: the ticket from the
       * same device's `media.connect` (ADR 0147 §5.2). Refused on any other channel, and a
       * `media` channel without it is refused.
       */
      mediaTicket: MediaTicket.optional(),
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
       * error code and live-end reason), `raw-on-demand` (items whose raw payloads clients
       * only show, in snapshots, pages, turn steps and live item events, come without them and
       * marked `rawOmitted`; `item.raw` reads them), `storage-hold` (accepts the `storage`
       * admission hold; without it the daemon sends that hold as `user`, ADR 0176). Unknown
       * names are ignored; without a name the daemon sends the full shape.
       */
      trims: z.array(z.string().max(32)).max(16).optional(),
      /**
       * Frame packing this client can undo: `lines` lets the daemon put several server messages
       * in one text frame, each one's JSON on its own line (joined by `\n`, which JSON text
       * never holds raw), in the order they were sent. `short-deltas` lets an events message
       * name its thread once (`threadId`) and carry each streamed delta as
       * `{seq, firstSeq?, at, d: [itemId, agentId, field, append]}`, without its event id.
       * Unknown names are ignored; without `lines` every frame holds exactly one message.
       */
      framing: z.array(z.string().max(32)).max(8).optional(),
      /**
       * With a ticket: this client keeps the next one in memory, so the welcome may carry a
       * fresh one-use ticket for its next connection (ADR 0150). Older daemons ignore it.
       */
      nextTicket: z.literal(true).optional(),
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
    /**
     * For a thread: any snapshot this subscription sends carries only the newest transcript
     * items, at most `items` of them in at most `bytes`; status, agents, interactions and queue
     * stay whole. Older items are read by `items.page` from the snapshot's `itemsBefore`. A
     * daemon that does not know the field sends its full snapshot.
     */
    tail: z
      .object({
        items: z.number().int().min(1).max(200),
        bytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024),
      })
      .optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), subscriptionId: z.string().min(1) }),
  z.object({ type: z.literal("command"), command: Command }),
  z.object({
    type: z.literal("output.read"),
    requestId: z.string().min(1),
    streamId: z.string().min(1),
    offset: seq,
    /**
     * The most bytes this read may return. The daemon may return fewer (newer daemons return at
     * most 16 KiB, so one reply never holds up an urgent message on a slow link); a reader goes
     * on from `nextOffset` until `eof`.
     */
    limit: seq.positive().max(256 * 1024),
  }),
  /**
   * A page of a request's whole JSON, for one a thread sends only summarized (`truncated`,
   * ADR 0157). From `offset` 0, then each reply's `nextOffset`, until `eof`.
   */
  z.object({
    type: z.literal("interaction.read"),
    requestId: z.string().min(1),
    threadId: ThreadId,
    interactionId: InteractionId,
    /** UTF-16 code units into the request's JSON. */
    offset: seq,
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
    /**
     * `Number.MAX_SAFE_INTEGER` for the first page, else the `entitiesBefore` of the page before,
     * passed back as it came. Newer daemons read any other value (an older daemon's cursor, a
     * snapshot's) as the first page; older daemons read a newer daemon's cursor as their own
     * first page, so a reader keeps entities by id.
     */
    before: seq.positive(),
    limit: seq.positive().max(200),
    /**
     * The most bytes of entries a page holds (16 KiB to 128 KiB); 128 KiB without it. Older
     * daemons ignore it. Newer daemons send active entities (pending requests, working agents)
     * first, page after page, then the rest. An entity larger than this goes alone and whole, so
     * that page exceeds it by that one entity; one too large for any reply is named in the
     * page's `tooLarge` instead.
     */
    maxBytes: seq
      .min(16 * 1024)
      .max(128 * 1024)
      .optional(),
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
  /**
   * An account device proves the person's standing on this socket (ADR 0190): a person's format 2
   * grant for this daemon and, signed with the device key it names, `standingProofText` over this
   * daemon's host id, the welcome's `standingNonce` and the grant. The standing lasts until the
   * grant expires; the client proves a fresh one before then. Answered with
   * `account.standing.result`.
   */
  z.object({
    type: z.literal("account.standing"),
    requestId: z.string().min(1).max(128),
    grant: z.string().min(1).max(2048),
    /** ECDSA P-256 SHA-256 signature, IEEE P1363 (64 bytes), base64url. */
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
  /**
   * A paired device proves the person's standing on this socket (ADR 0190): with the key it
   * named when it redeemed a link the person made, its ECDSA P-256 signature of
   * `pairedStandingText` over the welcome's `standingHost` and `standingNonce`, this socket's
   * channel binding and its device id. Answered with `account.standing.result`.
   */
  z.object({
    type: z.literal("device.standing"),
    requestId: z.string().min(1).max(128),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
  /**
   * The machine's owner hands it on (ADR 0190): from a socket proven as the owner only. Every
   * standing proven under it, and every person's pairing, ends; the next person's proof sets
   * the owner. Answered with `account.owner.release.result`.
   */
  z.object({
    type: z.literal("account.owner.release"),
    requestId: z.string().min(1).max(128),
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
     * Names the daemon's event database, made once with it. Sequences are this database's own: a
     * restored or reset database under the same host id starts them again, so a client resumes a
     * cursor kept on disk only under the same id (ADR 0128). Absent from older daemons.
     */
    databaseId: z.string().min(1).max(128).optional(),
    /**
     * For an ace account device: how long this socket's grant has left, in milliseconds. The
     * daemon closes the socket (4014) soon after unless `account.grant.refresh` brings a fresh
     * one. Absent for other credentials and from daemons that don't enforce it.
     */
    grantTtlMs: z.number().int().nonnegative().optional(),
    /**
     * For a hello that opened with a ticket and asked for the next (`nextTicket`): a fresh
     * one-use ticket for this device's next connection, valid `ttlMs` from now (ADR 0150). It
     * is bound to the device and its credential, and revoking the device voids it.
     */
    ticket: z
      .object({ ticket: z.string().regex(/^[0-9a-f]{64}$/), ttlMs: z.number().int().positive() })
      .optional(),
    /**
     * Relay stream handshakes this daemon takes besides Noise XX: `nk1` lets a client that holds
     * a ticket or grant open its next relay stream with Noise NK and an early hello (ADR 0155).
     * Trusted only as received in a welcome under the pinned host key. Unknown names are ignored.
     */
    relayHandshakes: z.array(z.string().max(16)).max(8).optional(),
    /**
     * The release line the daemon's build belongs to (ADR 0177): `beta` for a beta build, so a
     * client can say so; `stable` otherwise. Absent from older daemons; unknown names are kept.
     */
    releaseLine: z.string().min(1).max(32).optional(),
    /**
     * For an ace account device: this socket's nonce for `account.standing` (ADR 0190), new for
     * every socket, so a proof made for one is worth nothing on another. Absent for other
     * credentials and from older daemons.
     */
    standingNonce: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22,64}$/)
      .optional(),
    /**
     * With `standingNonce`: the host a proof of the person's standing names (ADR 0190), this
     * daemon's host id on ace's relay (its relay key's fingerprint). Not `hostId`, which names
     * the daemon's home to its clients.
     */
    standingHost: z
      .string()
      .regex(/^[A-Z2-7]{52}$/)
      .optional(),
  }),
  /**
   * On a relay stream opened with Noise NK (ADR 0155): the daemon took the client's
   * `hello.confirm` and has now run what a hello runs. With `nextTicket` asked, it carries the
   * one-use ticket for the next connection, as a welcome does on the other paths.
   */
  z.object({
    type: z.literal("hello.confirmed"),
    ticket: z
      .object({ ticket: z.string().regex(/^[0-9a-f]{64}$/), ttlMs: z.number().int().positive() })
      .optional(),
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
      /**
       * Events an NK relay session gets before it confirms (ADR 0155): applied ahead of the
       * subscription, which doesn't exist yet. They mark nothing current, ready or confirmed,
       * and the subscription that follows may still answer with a snapshot. Only an NK session
       * gets them.
       */
      early: z.literal(true).optional(),
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
  /**
   * A page of the request's JSON (`InteractionRequest`), `text` from `offset` to `nextOffset` of
   * `total` UTF-16 code units. `version` names the request a page is from: a reader whose pages
   * differ in it starts again from 0, as the request was replaced meanwhile. An answer to it
   * echoes it as `readWhole`.
   */
  z.object({
    type: z.literal("interaction.data"),
    requestId: z.string(),
    threadId: ThreadId,
    interactionId: InteractionId,
    version: z.string().min(1).max(64),
    offset: seq,
    nextOffset: seq,
    total: seq,
    text: z.string(),
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
  /** The answer to `account.owner.release`: whether this socket's owner let the machine go. */
  z.object({
    type: z.literal("account.owner.release.result"),
    requestId: z.string(),
    ok: z.boolean(),
  }),
  /** The answer to `account.standing` (ADR 0190): until when this socket is the person's. */
  z.object({
    type: z.literal("account.standing.result"),
    requestId: z.string(),
    /** `until`: when the person's standing on this socket ends, unless proven again. */
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), until: z.number().int().positive() }),
      z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(256) }),
    ]),
  }),
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
  "interaction.read",
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
  "interaction.data",
  "items.page",
  "threads.page",
  "entities.page",
  "entities.page.part",
  "command.status",
  "pong",
  "account.grant.refresh.result",
]);
