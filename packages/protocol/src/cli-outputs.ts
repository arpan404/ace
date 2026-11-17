import { z } from "zod";
import { CliOpenRequest, CliRequestList, CliTaskStatus, CliTree } from "./cli-control.ts";
import { ThreadStatus } from "./thread-status.ts";
import { Interaction } from "./interactions.ts";
import { Project } from "./projects.ts";
import { ThreadListWindow } from "./wire-core.ts";
import { ProviderKind } from "./provider-data.ts";

/**
 * A thread as the daemon sends it (`Thread`, `ThreadListEntry`), named by the fields a script
 * reads. The rest of the daemon's fields come along unchanged; the full shapes carry
 * transforms JSON Schema can't express, so `--schema` describes them this way.
 */
const CliThreadFacts = z.looseObject({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  provider: ProviderKind,
  status: ThreadStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** A transcript item as the daemon sends it (`Item`), by the fields every item has. */
const CliItemFacts = z.looseObject({
  id: z.string(),
  type: z.string(),
  agentId: z.string(),
  createdAt: z.number(),
});
import { CliCommandHelp, CliCommandTree, CliVersionOutput } from "./cli-output.ts";
import { cliMachineOutputs } from "./cli-outputs-machine.ts";
import { DaemonHealth } from "./release.ts";
import { cliAccessOutputs } from "./cli-outputs-access.ts";
import {
  MarketDiscover,
  MarketEntryDetail,
  MarketEntrySummary,
  MarketInstalled,
  MarketPublishAnswer,
  MarketPublisherPage,
  MarketReview,
  MarketSource,
} from "./marketplace.ts";

/**
 * Each command's `--json` success value, by the `output` key in the CLI's command table
 * (ADR 0176 §3). `ace help COMMAND --schema` prints one as JSON Schema. Adding a field is not
 * a breaking change; renaming or removing one goes through the CLI's deprecation window.
 */

/** `ace thread start` (`ace run`): the thread was admitted. */
export const CliAdmission = z.object({
  type: z.literal("admission"),
  ok: z.literal(true),
  status: z.literal("accepted"),
  commandId: z.string(),
  idempotencyKey: z.string(),
  threadId: z.string(),
});
export type CliAdmission = z.infer<typeof CliAdmission>;

/** A mutation's receipt: the daemon accepted it, under this idempotency key. */
export const CliReceipt = z.object({ ok: z.boolean(), idempotencyKey: z.string() }).loose();

export const CliDaemonStart = z.object({
  running: z.literal(true),
  url: z.string(),
  tokenPath: z.string(),
  remoteUrl: z.string().optional(),
  fingerprint: z.string().optional(),
});

export const CliDaemonDown = z.object({ running: z.literal(false) });

/** One row of `ace thread list`: the thread's state as the app's row shows it. */
export const CliThreadRow = z.object({
  threadId: z.string(),
  title: z.string(),
  project: z.string(),
  workspaceId: z.string(),
  provider: z.string(),
  branch: z.string().optional(),
  pinned: z.boolean(),
  settled: z.boolean(),
  /** needs-you, failed, working, waiting, limited, background, finished, idle or syncing. */
  state: z.string(),
  /** The state in words: "Needs approval", "Waiting on 2 agents". */
  meaning: z.string(),
  waitingOn: z.number().int().optional(),
  since: z.number().optional(),
  activityAt: z.number(),
});

/** `ace thread list`: the threads in the app's order, their rows, and the next page. */
export const CliThreadList = z.object({
  threads: z.array(CliThreadFacts),
  rows: z.array(CliThreadRow),
  next: z.string().nullable(),
  window: ThreadListWindow.optional(),
});

/** `ace thread show`: the thread, a bounded window of items and its requests. */
export const CliThreadShow = z.object({
  thread: CliThreadFacts,
  items: z.array(CliItemFacts),
  itemsBefore: z.number().nullable(),
  interactions: z.array(Interaction),
});

/** `ace thread status` for a thread no agent delegated: its state and its whole tree's. */
export const CliThreadState = z.object({
  threadId: z.string(),
  status: ThreadStatus,
  /** ok, failed, needs-human or uncertain once the whole tree has an outcome; else working. */
  state: z.string(),
  tree: CliTree,
});

/** `ace project show`. */
export const CliProjectShow = z.object({
  project: Project,
  threads: z.object({
    total: z.number().int(),
    needsYou: z.number().int(),
    running: z.number().int(),
  }),
});

/** `ace status`: the daemon's health (unchanged), plus the account and what needs you. */
export const CliStatus = z.union([
  DaemonHealth.loose().extend({
    account: z.object({ signedIn: z.boolean(), email: z.string().optional() }).optional(),
    /** Threads waiting on a person. */
    needsYou: z.number().int().optional(),
    /** Threads at work. Not `running`, which says whether the daemon runs. */
    working: z.number().int().optional(),
  }),
  CliDaemonDown,
]);
/** `ace market search`: one page of entries. */
export const CliMarketSearch = z.object({
  entries: z.array(MarketEntrySummary),
  total: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative().optional(),
});
/** `ace market show`: an entry's page, or a publisher's. */
export const CliMarketShow = z.union([
  z.object({ kind: z.literal("entry"), entry: MarketEntryDetail }),
  z.object({ kind: z.literal("publisher"), page: MarketPublisherPage }),
]);
/** `ace market install`: the review it was installed from, and what landed. */
export const CliMarketInstall = z.object({
  review: MarketReview,
  installed: MarketInstalled.optional(),
});
/** `ace market check`: the local checks passed. */
export const CliMarketCheck = z.object({
  type: z.string(),
  name: z.string(),
  hash: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  problems: z.array(z.object({ path: z.string().optional(), message: z.string() }).loose()),
});

export const cliOutputs = {
  help: z.union([CliCommandTree, CliCommandHelp]),
  version: CliVersionOutput,
  status: CliStatus,
  "daemon.status": z.union([DaemonHealth.loose(), CliDaemonDown]),
  "daemon.start": CliDaemonStart,
  "daemon.stop": z.object({ stopped: z.boolean() }).loose(),
  "thread.start": CliAdmission,
  "thread.wait": CliTree,
  "thread.status": z.union([CliTaskStatus, CliThreadState]),
  "thread.list": CliThreadList,
  "thread.show": CliThreadShow,
  "thread.tree": CliTree,
  "thread.fork": CliReceipt.and(z.object({ forkThreadId: z.string().optional() })),
  "request.list": CliRequestList,
  "request.show": CliOpenRequest,
  "project.list": z.object({ projects: z.array(Project), next: z.string().nullable() }).loose(),
  "project.show": CliProjectShow,
  receipt: CliReceipt,
  ...cliAccessOutputs,
  ...cliMachineOutputs,
  "market.discover": MarketDiscover,
  "market.search": CliMarketSearch,
  "market.show": CliMarketShow,
  "market.install": CliMarketInstall,
  "market.update": z.object({ updated: z.array(CliMarketInstall) }),
  "market.done": z.object({ ok: z.literal(true), installed: MarketInstalled.optional() }),
  "market.installed": z.object({ installed: z.array(MarketInstalled) }),
  "market.sources": z.object({ sources: z.array(MarketSource) }),
  "market.check": CliMarketCheck,
  /** Publishing: the market's answer as it is (ADR 0176 §12.5). */
  "market.publish": MarketPublishAnswer,
} satisfies Record<string, z.ZodType>;
export * from "./cli-outputs-machine.ts";
