import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { sourcesAnswer } from "./market-home.ts";
import { installedRow, type MarketWords } from "./market-rows.ts";

/*
 * A change whose reply never came back may still have happened on the machine: the daemon can
 * finish an install whose answer misses the deadline or the connection. Before the phone says
 * anything, it reads what the machine holds now and decides from that whether the change landed
 * (spec item 13). Pure: the change asked for and the read in, the answer out.
 */

/** The read that shows whether `operation` landed; none when its outcome needs no check. */
export function confirmingRead(operation: MarketOperation): MarketOperation | undefined {
  switch (operation.op) {
    case "install":
    case "remove":
    case "turnOn":
    case "turnOnForBots":
      return { op: "installed" };
    case "addSource":
    case "removeSource":
    case "setSource":
    case "refresh":
      return { op: "sources" };
    default:
      return undefined;
  }
}

type Installed = Extract<MarketResult, { op: "installed" }>["installed"][number];
const named =
  (type: string, name: string, bot?: string) =>
  (item: Installed): boolean =>
    item.type === type &&
    item.name === name &&
    (bot === undefined || (item.type === "spade-bot" && item.target === bot));

/**
 * The answer `operation` would have had, when `read` shows it landed; undefined when it shows
 * it didn't.
 */
export function confirmedAnswer(
  operation: MarketOperation,
  read: MarketResult,
  words: MarketWords,
): object | undefined {
  if (read.op === "sources") {
    const { sources } = read;
    const landed =
      operation.op === "addSource"
        ? sources.some((source) => source.address === operation.address)
        : operation.op === "removeSource"
          ? !sources.some((source) => source.id === operation.id)
          : operation.op === "setSource"
            ? sources.some(
                (source) => source.id === operation.id && source.enabled === operation.enabled,
              )
            : operation.op === "refresh";
    return landed ? sourcesAnswer(read, words) : undefined;
  }
  if (read.op !== "installed") return undefined;
  const items = read.installed;
  switch (operation.op) {
    case "install": {
      // A review installs exactly its hash: the row holding that hash is what it made.
      const item = items.find((each) => each.hash === operation.hash);
      return item ? { installed: installedRow(item) } : undefined;
    }
    case "remove":
      return items.some(named(operation.type, operation.name, operation.bot))
        ? undefined
        : { installed: null };
    case "turnOn": {
      const item = items.find(named(operation.type, operation.name, operation.bot));
      return item?.state === "on" ? { installed: installedRow(item) } : undefined;
    }
    case "turnOnForBots": {
      const item = items.find(
        (each) =>
          named("spade-skill", operation.name)(each) &&
          each.hash === operation.hash &&
          each.botsApproved !== false,
      );
      return item ? { installed: installedRow(item) } : undefined;
    }
    default:
      return undefined;
  }
}
