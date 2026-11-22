import type { MarketReviewItem } from "@ace/protocol/marketplace";

/* A review's page rows in words: what a plugin runs, and what an update changed. Pure. */

type Execution = Extract<MarketReviewItem, { kind: "execution" }>["execution"];
type Change = Extract<MarketReviewItem, { kind: "change" }>;

/** "Hook on SessionStart", "Server notes", "Remote server search". */
export function runTitle(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return `Hook on ${execution.event}`;
    case "stdio":
      return `Server ${execution.name}`;
    case "remote":
      return `Remote server ${execution.name}`;
  }
}

/** The command a hook or server runs, or the address a remote server is reached at. */
export function runDetail(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return execution.command;
    case "stdio":
      return [execution.command, ...execution.args].join(" ");
    case "remote":
      return execution.url;
  }
}

const changeWords = { added: "Added", changed: "Changed", removed: "Removed" } as const;

/** "Added scripts/run.sh": one file an update adds, changes or removes. */
export const changeTitle = (item: Pick<Change, "change" | "path">): string =>
  `${changeWords[item.change]} ${item.path}`;
