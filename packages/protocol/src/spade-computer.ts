import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { SpadeBotId } from "./spade-brains.ts";

/**
 * A Spade bot's computer as ace keeps it: its own browser and its use of the screen. Each bot
 * acts in ace as a hidden thread of its own, so its tabs and apps are never another bot's. Spade
 * names the bot on each MCP call it makes for one (`_meta` `ace/acting-for`), never in the tool's
 * arguments. Apps watch the browser as any thread's (`browser.subscribe` with `threadId`) and the
 * screen through `screen.request`, with those messages' scopes.
 */

const requestId = z.string().min(1).max(128);

/** Who drives a bot's browser and screen: the bot, or the person who took over. */
export const SpadeComputerDriver = z.enum(["bot", "person"]);
export type SpadeComputerDriver = z.infer<typeof SpadeComputerDriver>;

export const SpadeComputerTab = z.object({
  tabId: z.string().min(1).max(128),
  title: z.string().max(1024),
  url: z.string().max(8192),
});
export type SpadeComputerTab = z.infer<typeof SpadeComputerTab>;

export const SpadeComputer = z.object({
  bot: SpadeBotId,
  driver: SpadeComputerDriver,
  /** The bot's hidden thread, for `browser.subscribe`; absent until the bot first used either. */
  threadId: ThreadId.optional(),
  browser: z.object({ tabs: z.array(SpadeComputerTab).max(64) }),
  /** Apps the bot is using now (computer use), in the order it began; empty when none. */
  screen: z.object({
    apps: z.array(z.string().min(1).max(200)).max(16),
    /** When it began using the first of them, ms since the epoch. */
    since: z.number().int().nonnegative().optional(),
  }),
});
export type SpadeComputer = z.infer<typeof SpadeComputer>;

/** What the person did while driving, for the bot's resume note. */
export const SpadeComputerHandback = z.object({
  /** How long the person drove, in ms. */
  drivenMs: z.number().int().nonnegative(),
  /** Addresses the bot's tabs went to, in order, without repeats. */
  visited: z.array(z.string().max(8192)).max(64),
  opened: z.array(SpadeComputerTab).max(64),
  closed: z.array(SpadeComputerTab).max(64),
  /** Whether a screen session watched or drove an app while the person drove. */
  screenUsed: z.boolean(),
});
export type SpadeComputerHandback = z.infer<typeof SpadeComputerHandback>;

/** A bot's computer now. Operate scope. */
export const SpadeComputerGet = z.object({
  type: z.literal("spade.computer.get"),
  requestId,
  bot: SpadeBotId,
});
export const SpadeComputerResult = z.object({
  type: z.literal("spade.computer.result"),
  requestId: z.string(),
  computer: SpadeComputer.optional(),
  error: z.enum(["forbidden", "unavailable"]).optional(),
});
export type SpadeComputerResult = z.infer<typeof SpadeComputerResult>;

/**
 * Hands a bot's computer to the person or back. While the person drives, the bot's browser and
 * screen tools are refused with `person_driving`. Handing back answers with what the person did.
 * Idempotent: setting the current driver changes nothing and reports no hand-back. Operate scope.
 */
export const SpadeComputerDrive = z.object({
  type: z.literal("spade.computer.drive"),
  requestId,
  bot: SpadeBotId,
  driver: SpadeComputerDriver,
});
export const SpadeComputerDriveResult = z.object({
  type: z.literal("spade.computer.drive.result"),
  requestId: z.string(),
  driver: SpadeComputerDriver.optional(),
  handback: SpadeComputerHandback.optional(),
  error: z.enum(["forbidden", "unavailable"]).optional(),
});
export type SpadeComputerDriveResult = z.infer<typeof SpadeComputerDriveResult>;
