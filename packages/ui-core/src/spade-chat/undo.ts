import type { SpadeReplyPart } from "./fold.ts";

/*
 * Undo in the conversation (ADR 0167, spade/docs/security.md "Undo in the conversation"): a step
 * that changed the bot's own files can be undone from the checkpoint Spade took before it, and a
 * reply's step line undoes its whole turn from its first such step. What a step did outside the
 * bot's box can't be undone, and the step says so plainly. Pure, so every client reads it the same.
 */

type CallPart = Extract<SpadeReplyPart, { kind: "call" }>;

/** Spade's file tools, which change only the bot's own workspace. */
const fileTools = new Set(["workspace_write", "workspace_edit"]);

const baseName = (name: string) => name.split("__").at(-1) ?? name;

/** An app's tool (`<app>__<tool>`), which acts in that app, not on the bot's computer. */
function appOf(name: string): string | undefined {
  const [app, ...rest] = name.split("__");
  return rest.length && app && app !== "ace" ? app : undefined;
}

/**
 * What a declared effect leaves outside the bot's box, said plainly; undefined for one that
 * stays inside it (`read`, `write_local`, `credential`). The words are Spade's gate's
 * (`spade_core::effect::Effect`), recorded on the step's `tool_started`.
 */
function effectStays(effect: string, app: string | undefined): string | undefined {
  switch (effect) {
    case "pay":
      return "Can't be undone: a payment can't be taken back from here.";
    case "send_as_person":
      return "Can't be undone: it was sent in your name.";
    case "publish":
      return "Can't be undone: it's published.";
    case "change_access":
      return "Can't be undone here: it changed sign-ins or who has access.";
    case "network":
      return app
        ? `Can't be undone here: it changed ${app}.`
        : "Can't be undone here: it changed something outside the bot.";
    case "drive":
      return "Can't be undone here: it acted in a page or an app.";
    case "unknown":
      return "Can't be undone here: it may have changed something outside the bot.";
    default:
      return undefined;
  }
}

/**
 * Why a step can't be undone, said plainly; undefined when it only touched the bot's own files
 * or changed nothing outside. Only steps that ran count. Read from what the tool declared to
 * Spade's gate (`effect`) and where a command ran (`ran`), never from the tool's name.
 */
export function spadeCantUndo(part: CallPart): string | undefined {
  if (part.state !== "done" && part.state !== "failed") return undefined;
  const declared = part.effect && effectStays(part.effect, appOf(part.name));
  // A failed step may or may not have gone out: never say it was sent, paid or published.
  if (declared && part.state === "failed")
    return "Can't be undone from here if any of it went through.";
  if (declared) return declared;
  const ran = part.ran;
  if (ran?.contained === false) return "Can't be undone here: it ran outside the bot's sandbox.";
  // A command that reached the network and acts outward (a push, an upload): what it sent stays.
  if (ran && ran.reached.length > 0 && part.weight === "outward")
    return `Can't be undone: what it sent to ${ran.reached[0]} stays there.`;
  return undefined;
}

/**
 * Whether undo can reach a step: a file tool's write, or a command Spade's sandbox held (it may
 * have changed the bot's files and nothing else), once it ran. Its position (`logged`) names the
 * checkpoint.
 */
export function spadeUndoable(part: CallPart): boolean {
  if (part.state !== "done" && part.state !== "failed") return false;
  if (part.logged === undefined || spadeCantUndo(part) !== undefined) return false;
  const base = baseName(part.name);
  if (fileTools.has(base)) return true;
  return base === "shell" && part.ran?.contained === true;
}

/** What undoing a turn reaches: from its first undoable step, and the steps it can't take back. */
export interface SpadeTurnUndo {
  /** The `seq` of the turn's first undoable step. */
  from: number;
  /** "Sent an email": the turn's steps undo leaves as they are, each in a line. */
  stays: readonly string[];
}

/**
 * A turn's undo, from its parts; undefined when nothing in it can be undone. `line` words a step
 * ("Sent an email").
 */
export function spadeTurnUndo(
  parts: readonly SpadeReplyPart[],
  line: (part: CallPart) => string,
): SpadeTurnUndo | undefined {
  let from: number | undefined;
  const stays: string[] = [];
  for (const part of parts) {
    if (part.kind !== "call") continue;
    if (from === undefined && spadeUndoable(part)) from = part.logged;
    if (spadeCantUndo(part)) stays.push(line(part));
  }
  return from === undefined ? undefined : { from, stays };
}

/** What restoring a checkpoint would do, as Spade answers `GET …/checkpoints/undo`. */
export interface SpadeUndoPreview {
  checkpoint: { id: string; at: number };
  /** Files that go back to how they were. */
  changed: readonly string[];
  /** Files made since, which go. */
  added: readonly string[];
  /** Files removed since, which come back. */
  deleted: readonly string[];
  /** Paths past the lists, counted. */
  more: number;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Spade's undo preview; undefined when the body isn't one. */
export function parseSpadeUndoPreview(raw: unknown): SpadeUndoPreview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const checkpoint = body.checkpoint as Record<string, unknown> | undefined;
  const changes = body.changes as Record<string, unknown> | undefined;
  if (typeof checkpoint?.id !== "string" || typeof checkpoint.at !== "number" || !changes)
    return undefined;
  return {
    checkpoint: { id: checkpoint.id, at: checkpoint.at },
    changed: strings(changes.changed),
    added: strings(changes.added),
    deleted: strings(changes.deleted),
    more: typeof changes.more === "number" ? changes.more : 0,
  };
}

const files = (count: number) => (count === 1 ? "1 file" : `${count} files`);
const verb = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** "3 files go back, 1 made since goes"; "Nothing to undo" when the files are as they were. */
export function spadeUndoSummary(preview: SpadeUndoPreview): string {
  const { changed, added, deleted, more } = preview;
  const parts: string[] = [];
  if (changed.length)
    parts.push(`${files(changed.length)} ${verb(changed.length, "goes", "go")} back`);
  if (added.length)
    parts.push(`${files(added.length)} made since ${verb(added.length, "goes", "go")}`);
  if (deleted.length)
    parts.push(
      `${files(deleted.length)} removed since ${verb(deleted.length, "comes", "come")} back`,
    );
  if (!parts.length) return more ? `${files(more)} change` : "Nothing to undo";
  const said =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`
      : (parts[0] ?? "");
  return more ? `${said}, and ${more} more` : said;
}
