import { spadeRecord } from "./json.ts";
import { spadeToolWords } from "./words.ts";

/*
 * A bot's request as the strip above the composer says it: who wants to do what, to whom, the
 * first line of what it would send or run, and the verbs of its two answers.
 */

export interface SpadeRequestWords {
  /** "Inbox wants to send an email to Marta Reyes" */
  title: string;
  /** The first line of what it would send, write or run; undefined when the call carries none. */
  detail: string | undefined;
  allow: string;
  deny: string;
}

/** A name or address from a `to` field: a string, a list of them, or `{name, email}`. */
function recipient(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const names = value.map(recipient).filter((name) => name !== undefined);
    if (!names.length) return undefined;
    return names.length > 2 ? `${names[0]} and ${names.length - 1} others` : names.join(" and ");
  }
  const fields = spadeRecord(value);
  if (!fields) return undefined;
  return recipient(fields.name) ?? recipient(fields.email) ?? recipient(fields.address);
}

const textFields = ["body", "text", "content", "message", "command", "query", "url", "path"];

function firstLine(args: Record<string, unknown> | undefined): string | undefined {
  for (const field of textFields) {
    const value = args?.[field];
    if (typeof value !== "string") continue;
    const line = value
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean);
    if (line) return line;
  }
  return undefined;
}

export function spadeRequestWords(name: string, args: unknown, who: string): SpadeRequestWords {
  const fields = spadeRecord(args);
  const base = spadeToolWords(name).base;
  const to = recipient(fields?.to ?? fields?.recipient ?? fields?.recipients);
  const verb = base.split(" ")[0] ?? "";
  // A send names its own answers; anything else is allowed or denied.
  const sends = verb === "send" || verb === "reply" || verb === "post";
  const runs = name === "shell";
  return {
    title: `${who} wants to ${base}${to ? ` to ${to}` : ""}`,
    detail: firstLine(fields) ?? (typeof args === "string" ? args.split("\n")[0] : undefined),
    allow: sends ? "Send" : runs ? "Run" : "Allow",
    deny: sends ? "Don't send" : runs ? "Don't run" : "Deny",
  };
}

/**
 * A bot's problem as its list line says it: the next step in a few words ("Sign in to Codex to
 * go on"), else its first sentence. The whole reason and its action stay in the conversation.
 */
export function spadeProblemStep(problem: string): string {
  const signedOut = /^(.+?) is signed out/i.exec(problem.trim());
  if (signedOut?.[1]) return `Sign in to ${signedOut[1]} to go on`;
  const first = problem.trim().split(/(?<=[.!?])\s/)[0] ?? problem;
  return first.replace(/[.!]$/, "");
}
