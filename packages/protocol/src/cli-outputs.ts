import { z } from "zod";
import { CliTaskStatus, CliTree } from "./cli-control.ts";
import { CliCommandHelp, CliCommandTree, CliVersionOutput } from "./cli-output.ts";
import { DaemonHealth } from "./release.ts";
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
  status: z.union([DaemonHealth.loose(), CliDaemonDown]),
  "daemon.status": z.union([DaemonHealth.loose(), CliDaemonDown]),
  "daemon.start": CliDaemonStart,
  "daemon.stop": z.object({ stopped: z.boolean() }).loose(),
  "thread.start": CliAdmission,
  "thread.wait": CliTree,
  "thread.status": CliTaskStatus,
  receipt: CliReceipt,
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
