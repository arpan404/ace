import { commandRisk } from "../command-risk.ts";
import { spadeRecord } from "./json.ts";

/*
 * What a reply's step touched, read once from the call as the bot sent it: one line of it (the
 * command, a file's path, a page's address, a search's words) and whether it is the kind of step
 * the person must see without opening anything. This only decides what the conversation shows
 * first; it is never a gate (Spade decides on effects, ADR 0171).
 */

/**
 * `destructive`: it deletes or can't be undone (Spade's own `destructive` risk, or a command that
 * deletes by force, rewrites history or pipes a download into a shell). `outward`: it acts
 * outside the bot's own things (a push, a comment, a message, an app it changes, a command that
 * reaches the network).
 */
export type SpadeStepWeight = "destructive" | "outward";

/** Spade's tools that act in the person's name outside its box (ADR 0171 decision 2). */
const outwardTools = new Set([
  "git_push",
  "pr_comment",
  "issue_comment",
  "send_message",
  "send_email",
]);

/** The longest a detail runs before it is cut. */
const longest = 200;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** One line: its first line, cut with an ellipsis past `longest`. */
function oneLine(value: string): string {
  const lines = value.split("\n").filter((line) => line.trim());
  const first = (lines[0] ?? "").trim();
  const more = lines.length > 1 ? " …" : "";
  return first.length > longest ? `${first.slice(0, longest - 1)}…` : `${first}${more}`;
}

/** `call_tool` carries the tool it reaches inside: `{name, arguments}`. */
function reached(name: string, args: unknown): { name: string; args: unknown } {
  const fields = spadeRecord(args);
  const inner = text(fields?.name) ?? text(fields?.tool);
  if (name !== "call_tool" || !inner) return { name, args };
  return { name: inner, args: fields?.arguments ?? {} };
}

/** A call's one line of what it touched, from the fields that say it; undefined otherwise. */
function detailOf(name: string, args: unknown): string | undefined {
  const fields = spadeRecord(args);
  if (!fields) return undefined;
  const base = name.split("__").at(-1) ?? name;
  if (base === "shell") return text(fields.command);
  const said =
    text(fields.path) ??
    text(fields.url) ??
    text(fields.query) ??
    text(fields.branch) ??
    text(fields.repo) ??
    text(fields.subject);
  return said;
}

/** The step's detail and weight, from its name, its arguments and Spade's `risk` if known. */
export function spadeStepFacts(
  rawName: string,
  rawArgs: unknown,
): { detail: string | undefined; weight: SpadeStepWeight | undefined } {
  const { name, args } = reached(rawName, rawArgs);
  const detail = detailOf(name, args);
  const base = name.split("__").at(-1) ?? name;
  let weight: SpadeStepWeight | undefined;
  if (base === "shell") {
    const command = text(spadeRecord(args)?.command);
    const risk = command ? commandRisk(command) : undefined;
    weight = risk?.level === "high" ? "destructive" : risk ? "outward" : undefined;
  } else if (outwardTools.has(base)) weight = "outward";
  return { detail: detail === undefined ? undefined : oneLine(detail), weight };
}

/**
 * A weight from Spade's `risk` once the call starts: its own `destructive` always weighs most;
 * an app's tool (`<app>__<tool>`) that writes acts outside the bot.
 */
export function spadeRiskWeight(
  name: string,
  risk: string | null | undefined,
): SpadeStepWeight | undefined {
  if (risk === "destructive") return "destructive";
  const app = name.includes("__") && !name.startsWith("ace__");
  return app && risk === "write" ? "outward" : undefined;
}
