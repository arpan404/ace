import { spadeRecord } from "./json.ts";
import { spadeToolWords } from "./words.ts";

/*
 * A bot's request as its bubble says it: one sentence of what it wants to do, in Spade's words
 * (never a tool's raw name), the detail that matters for that kind of call (a command, a file's
 * path, a note, an email's recipient and subject; never raw JSON), and whether "Always allow"
 * holds for it.
 */

/** What a request would do, by the kind of call. Text stays text: views escape it. */
export type SpadeRequestDetail =
  | { kind: "command"; command: string }
  /** A file it would write whole (`text`) or change (`before` → `after`). */
  | { kind: "file"; path: string; text?: string; before?: string; after?: string }
  /** A note it would save or rewrite: `before` the note's text now, when known. */
  | { kind: "note"; text: string; before?: string }
  | { kind: "email"; to: string | undefined; subject: string | undefined; body: string | undefined }
  /** A message to another bot: its name (or id, when unknown) and what it would say. */
  | { kind: "message"; to: string; text: string }
  /** Anything else: its fields as label and plain value. */
  | { kind: "fields"; fields: readonly { label: string; value: string }[] };

export interface SpadeRequestCard {
  /** "Inbox wants to send an email to Marta Reyes." */
  sentence: string;
  detail: SpadeRequestDetail | undefined;
  /** "Always allow" holds for this tool: Spade's own writes, which the gate lets run once allowed. */
  always: boolean;
}

/**
 * Spade's own tools a person may allow always (`Risk::Write` in the spade-server crate; a command for that
 * exact command). Connectors' and ace's tools may be destructive, which always asks, and the
 * request doesn't say, so they offer Allow and Deny only.
 */
const alwaysTools = new Set([
  "shell",
  "workspace_write",
  "workspace_edit",
  "bot_message",
  "routine_save",
  "routine_delete",
]);

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

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

/** `call_tool` carries the tool it reaches inside: `{name, arguments}`. */
function unwrap(name: string, args: unknown): { name: string; args: unknown } {
  const fields = spadeRecord(args);
  const inner = text(fields?.name) ?? text(fields?.tool);
  if (name !== "call_tool" || !inner) return { name, args };
  return { name: inner, args: fields?.arguments ?? {} };
}

/** `due_date` → "Due date". */
const label = (key: string) => {
  const words = key.replaceAll(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A field's value in words: text as it is, numbers and yes/no, lists joined; deeper values by their own fields. */
function plain(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const items = value.map((item) => plain(item, depth + 1)).filter((item) => item !== undefined);
    // Steps (objects) one per line; plain items in a row.
    const steps = value.some((item) => spadeRecord(item) !== undefined);
    return items.length ? items.join(steps ? "\n" : ", ") : undefined;
  }
  const fields = spadeRecord(value);
  if (!fields || depth > 1) return undefined;
  const parts = Object.entries(fields).flatMap(([key, inner]) => {
    const said = plain(inner, depth + 1);
    return said === undefined ? [] : [`${label(key)}: ${said}`];
  });
  return parts.length ? parts.join("; ") : undefined;
}

function detailOf(
  name: string,
  args: unknown,
  options: SpadeRequestLookups,
): SpadeRequestDetail | undefined {
  const noteText = options.noteText;
  const fields = spadeRecord(args);
  if (typeof args === "string")
    return args.trim()
      ? { kind: "fields", fields: [{ label: "Details", value: args }] }
      : undefined;
  if (!fields) return undefined;
  const command = text(fields.command);
  if (name === "shell" && command) return { kind: "command", command };
  const path = text(fields.path);
  if (name === "workspace_write" && path)
    return {
      kind: "file",
      path,
      ...(typeof fields.content === "string" ? { text: fields.content } : {}),
    };
  if (name === "workspace_edit" && path)
    return {
      kind: "file",
      path,
      ...(typeof fields.old === "string" ? { before: fields.old } : {}),
      ...(typeof fields.new === "string" ? { after: fields.new } : {}),
    };
  const note = text(fields.text);
  if ((name === "memory_save" || name === "memory_update") && note) {
    const id = text(fields.id);
    const before = id ? noteText?.(id) : undefined;
    return { kind: "note", text: note, ...(before ? { before } : {}) };
  }
  if (name === "memory_forget") {
    const id = text(fields.id);
    const before = id ? noteText?.(id) : undefined;
    return before ? { kind: "note", text: before } : undefined;
  }
  const bot = text(fields.bot);
  const words = text(fields.text);
  if (name === "bot_message" && bot && words)
    return { kind: "message", to: options.botName?.(bot) ?? bot, text: words };
  const to = recipient(fields.to ?? fields.recipient ?? fields.recipients);
  const subject = text(fields.subject);
  if (to || subject)
    return {
      kind: "email",
      to,
      subject,
      body: text(fields.body) ?? text(fields.text) ?? text(fields.message),
    };
  const list = Object.entries(fields).flatMap(([key, value]) => {
    const said = plain(value);
    return said === undefined ? [] : [{ label: label(key), value: said }];
  });
  return list.length ? { kind: "fields", fields: list } : undefined;
}

/** What the client knows that the call names only by id. */
export interface SpadeRequestLookups {
  /** A deferred tool's title by its connector's name. */
  title?: ((name: string) => string | undefined) | undefined;
  /** A note's text by its id. */
  noteText?: ((id: string) => string | undefined) | undefined;
  /** A bot's name by its id (`bot_message`). */
  botName?: ((id: string) => string | undefined) | undefined;
}

/**
 * A request's words. `who` asks ("Learning", "A helper of Learning"); `title` names a tool this
 * table doesn't know by its connector's own name ("Gmail send message"), else its name in
 * words; `noteText` reads a note the call would change, when the client has it.
 */
export function spadeRequestCard(
  rawName: string,
  rawArgs: unknown,
  who: string,
  options: SpadeRequestLookups = {},
): SpadeRequestCard {
  const { name, args } = unwrap(rawName, rawArgs);
  const titled = options.title?.(name);
  const base = titled ? `use ${titled}` : spadeToolWords(name).base;
  const fields = spadeRecord(args);
  const to = recipient(fields?.to ?? fields?.recipient ?? fields?.recipients);
  return {
    sentence: `${who} wants to ${base}${to ? ` to ${to}` : ""}.`,
    detail: detailOf(name, args, options),
    always: alwaysTools.has(name),
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
