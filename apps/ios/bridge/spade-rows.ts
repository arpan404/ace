import { formatAge, initials } from "@ace/ui-core";
import {
  spadeAgentLine,
  spadeApprovalSentence,
  spadeAvatarFill,
  spadeCallDetails,
  spadeFailureSentence,
  spadeShellCommand,
  type SpadeAgent,
  type SpadeAvatar,
  type SpadeBubble,
  type SpadeView,
} from "@ace/ui-core/spade-chat";

/*
 * Spade's roster and a bot's conversation as the iPhone draws them, from the shared fold,
 * bubbles and words (`@ace/ui-core/spade-chat`, ADR 0127). Pure: no I/O. Swift lays these rows
 * out and decides nothing.
 */

/** A face: the Spade mark, an uploaded image (read with `spade.image`), or initials on a fill. */
export type SpadeFaceRow =
  | { kind: "spade" }
  | { kind: "image"; sha256: string; initials: string; fill: string }
  | { kind: "generated"; initials: string; fill: string };

export function spadeFaceRow(avatar: SpadeAvatar, name: string): SpadeFaceRow {
  if (avatar.kind === "spade") return { kind: "spade" };
  if (avatar.kind === "image")
    return { kind: "image", sha256: avatar.sha256, initials: initials(name) || "?", fill: slate };
  return { kind: "generated", initials: avatar.initials, fill: spadeAvatarFill[avatar.color] };
}

const slate = spadeAvatarFill.slate;

/** One roster row: the bot's face and name, when it was last active, and what it does now. */
export function spadeRosterRow(agent: SpadeAgent, now: number) {
  const line = spadeAgentLine(agent);
  return {
    id: agent.id,
    conversation: agent.conversation,
    main: agent.kind === "main",
    name: agent.name,
    face: spadeFaceRow(agent.avatar, agent.name),
    age: formatAge(agent.lastActivity, now),
    line: line.text,
    tone: line.tone ?? null,
    working: agent.state === "working",
  };
}

/** What came with a message, in words: "1 image · 2 files". Null with nothing. */
function attachmentsLine(images: number, documents: number, voice: boolean): string | null {
  const parts = [
    images ? (images === 1 ? "1 image" : `${images} images`) : "",
    documents ? (documents === 1 ? "1 file" : `${documents} files`) : "",
    voice ? "Voice message" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type SpadeBubbleRow =
  | { kind: "person"; text: string; attachments: string | null; sending: boolean }
  | {
      kind: "bot";
      text: string;
      live: boolean;
      /** How the reply ended when it didn't finish on its own, and nothing more is known. */
      end: string | null;
      /** Why it failed: the sentence, Spade's words for Details, and the words Try again sends. */
      failure: { sentence: string; details: string | null; retry: string | null } | null;
      attachments: string | null;
    }
  /** Another bot's message in this conversation, under its name. */
  | { kind: "other"; name: string; text: string }
  /** A small label in the middle (a routine fired, a group asked), and what it said, quietly. */
  | { kind: "label"; label: string; text: string | null }
  /** One quiet line on the bot's side. */
  | { kind: "note"; text: string }
  | {
      kind: "ask";
      callId: string;
      sentence: string;
      /** Why the model review asked the person rather than let it run. */
      reason: string | null;
      /** A shell call's exact command, which Always allow covers. */
      command: string | null;
      details: string | null;
    };

/** What a row needs beyond its bubble: the bot's name, and an endpoint's name by its id. */
export interface SpadeRowContext {
  botName: string;
  endpointName(id: string): string | undefined;
}

export function spadeBubbleRow(bubble: SpadeBubble, context: SpadeRowContext): SpadeBubbleRow {
  switch (bubble.kind) {
    case "person":
      return {
        kind: "person",
        text: bubble.text,
        attachments: attachmentsLine(
          bubble.images.length,
          bubble.documents.length,
          bubble.voice !== undefined,
        ),
        sending: bubble.sending,
      };
    case "bot": {
      const failure =
        bubble.end === "failed" && bubble.failure
          ? {
              sentence: spadeFailureSentence(
                bubble.failure.kind,
                bubble.failure.endpoint && context.endpointName(bubble.failure.endpoint),
              ),
              details: bubble.failure.error || null,
              retry: bubble.failure.retry ?? null,
            }
          : null;
      const files = bubble.files?.length ?? 0;
      return {
        kind: "bot",
        text: bubble.text,
        live: bubble.live,
        end: failure ? null : endWords(bubble.end),
        failure,
        attachments: attachmentsLine(bubble.images.length, bubble.documents.length + files, false),
      };
    }
    case "other":
      return { kind: "other", name: bubble.agent.name, text: bubble.text };
    case "group":
      return {
        kind: "label",
        label: bubble.agent ? `In ${bubble.group} · ${bubble.agent.name}` : `In ${bubble.group}`,
        text: bubble.text || null,
      };
    case "routine":
      return { kind: "label", label: `${bubble.name} · ${bubble.label}`, text: null };
    case "files":
      return { kind: "note", text: `Kept ${bubble.paths.join(", ")}` };
    case "remembered":
      return { kind: "note", text: `Remembered: ${bubble.note.text}` };
    case "search-setup":
      return { kind: "note", text: "Web search isn't set up." };
    case "ask":
      return {
        kind: "ask",
        callId: bubble.callId,
        sentence: spadeApprovalSentence(bubble.name, context.botName),
        reason: bubble.reason ?? null,
        command: spadeShellCommand(bubble.name, bubble.arguments) ?? null,
        details: spadeShellCommand(bubble.name, bubble.arguments)
          ? null
          : (spadeCallDetails(bubble.arguments) ?? null),
      };
  }
}

function endWords(end: "stopped" | "failed" | "interrupted" | undefined): string | null {
  if (end === "stopped") return "Stopped";
  if (end === "failed") return "Couldn't finish";
  if (end === "interrupted") return "Interrupted";
  return null;
}

/** The conversation around its bubbles: whether it loaded, why it can't follow, and its status. */
export function spadeConversationPatch(
  agentId: string,
  view: SpadeView,
  problem: string | undefined,
) {
  // Busy: anything open, waiting on the person too. The face moves only while the bot works.
  const waiting = view.approvals.length > 0 || view.asking;
  return {
    type: "spade.conversation",
    agentId,
    loaded: view.loaded,
    problem: problem ?? null,
    busy: view.busy,
    status: view.busy
      ? { text: waiting ? "Waiting for you" : (view.status ?? "Working"), moving: !waiting }
      : null,
  };
}

/** Whether two rows read the same, field by field: what Swift holds needs no new copy then. */
export function sameSpadeRow(a: SpadeBubbleRow, b: SpadeBubbleRow): boolean {
  const left: Record<string, unknown> = a;
  const right: Record<string, unknown> = b;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const x = left[key];
    const y = right[key];
    if (x === y) return true;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    const inner = Object.keys(x);
    return (
      inner.length === Object.keys(y).length &&
      inner.every(
        (field) => (x as Record<string, unknown>)[field] === (y as Record<string, unknown>)[field],
      )
    );
  });
}
