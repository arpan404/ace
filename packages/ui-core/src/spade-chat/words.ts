import type { SpadeStatus } from "@ace/protocol";
import type { SpadeCallState } from "./fold.ts";

/*
 * Spade's states and tools in words. Tool names are Spade's own (`web_search`) or an ace tool
 * it reaches through MCP; one this table doesn't know reads by its name.
 */

interface ToolWords {
  /** "search the web": after "Spade wants to". */
  base: string;
  /** "Searching the web": the Working line. */
  doing: string;
  /** "Searched the web": a call that ran. */
  done: string;
}

const tools: Record<string, ToolWords> = {
  web_search: { base: "search the web", doing: "Searching the web", done: "Searched the web" },
  web_fetch: { base: "read a web page", doing: "Reading a web page", done: "Read a web page" },
  todo: { base: "update its plan", doing: "Updating its plan", done: "Updated its plan" },
  tool_search: { base: "look for a tool", doing: "Looking for a tool", done: "Looked for a tool" },
  skill_search: {
    base: "look for a skill",
    doing: "Looking for a skill",
    done: "Looked for a skill",
  },
  call_tool: { base: "use a tool", doing: "Using a tool", done: "Used a tool" },
  send_email: { base: "send an email", doing: "Sending an email", done: "Sent an email" },
  research: { base: "research", doing: "Researching", done: "Researched" },
};

/** `ace__thread_start` → "thread start". */
function plainName(name: string): string {
  const last = name.split("__").at(-1) ?? name;
  return last.replaceAll(/[_-]+/g, " ").trim() || name;
}

export function spadeToolWords(name: string): ToolWords {
  const known = tools[name];
  if (known) return known;
  const plain = plainName(name);
  return { base: `use ${plain}`, doing: `Using ${plain}`, done: `Used ${plain}` };
}

/** A call's line in a reply: what it did, or why it didn't. */
export function spadeCallLine(name: string, state: SpadeCallState): string {
  const words = spadeToolWords(name);
  switch (state) {
    case "done":
      return words.done;
    case "failed":
      return `Couldn't ${words.base}`;
    case "declined":
      return `You declined: ${words.base}`;
    case "skipped":
      return `Didn't ${words.base}`;
    case "waiting":
      return `Waiting for you: ${words.base}`;
    case "queued":
    case "running":
      return words.doing;
  }
}

/** The approval's one sentence: "Spade wants to send an email." */
export function spadeApprovalSentence(name: string): string {
  return `Spade wants to ${spadeToolWords(name).base}.`;
}

/** What the Spade place says about Spade itself, and whether it offers Turn on. */
export interface SpadeStateLine {
  sentence: string;
  /** Spade is ready for requests. */
  ready: boolean;
  /** The setting is off, so the person can turn it on. */
  canTurnOn: boolean;
}

/**
 * `enabled` is the `spade.enabled` setting (undefined while it loads). With it on, the daemon's
 * status says the rest: starting, running, or why it is off or stopped.
 */
export function spadeStateLine(
  status: SpadeStatus | undefined,
  enabled: boolean | undefined,
): SpadeStateLine {
  if (enabled === false) return { sentence: "Spade is off.", ready: false, canTurnOn: true };
  if (!status) return { sentence: "Checking Spade…", ready: false, canTurnOn: false };
  switch (status.state) {
    case "ready":
      return { sentence: "Spade is running.", ready: true, canTurnOn: false };
    case "starting":
      return { sentence: "Spade is starting.", ready: false, canTurnOn: false };
    case "off":
      return {
        sentence: status.reason ?? "Spade is off.",
        ready: false,
        canTurnOn: enabled === undefined && !status.reason,
      };
    case "failed":
      return {
        sentence: status.reason ? `Spade stopped. ${status.reason}` : "Spade stopped.",
        ready: false,
        canTurnOn: false,
      };
  }
}

/** A list row works while Spade answers in it or a background job of its is out. */
export function spadeRowWorking(row: { answering: boolean; jobs: number }): boolean {
  return row.answering || row.jobs > 0;
}
