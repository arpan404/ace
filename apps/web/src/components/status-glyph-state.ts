import type { AgentGlyph, ThreadMarkKind, Tone } from "@ace/ui-core";

/**
 * The Aperture status set: every state is the same 16-unit ring, and only its opening or one
 * small interior mark changes. An open ring is still in motion (working, background, subagents,
 * queued); a closed ring has settled (done, failed, stopped, paused); a solid disc needs the
 * person; a bare dot is idle.
 */
export type GlyphState =
  | "working"
  | "background"
  | "subagents"
  | "needs-you"
  | "done"
  | "failed"
  | "stopped"
  | "queued"
  | "paused"
  | "idle";

/** The tone (`data-tone`, index.css) a glyph draws in when the caller doesn't name one. */
export const glyphTones: Record<GlyphState, Tone> = {
  working: "working",
  subagents: "working",
  background: "background",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  stopped: "idle",
  queued: "waiting",
  paused: "waiting",
  idle: "idle",
};

/**
 * A thread's glyph from the status its row already shows. Waiting splits by what holds it: a
 * usage limit pauses the thread (its mark is `limited`); anything else leaves it queued.
 */
export function threadGlyph(status: { tone: Tone; mark: ThreadMarkKind }): GlyphState {
  switch (status.tone) {
    case "waiting":
      return status.mark === "limited" ? "paused" : "queued";
    case "working":
    case "background":
    case "needs-you":
    case "done":
    case "failed":
    case "idle":
      return status.tone;
  }
}

/**
 * An agent's glyph from its mark (`agentMark`): an agent whose own turn ended while its
 * subagents or commands still run waits on them.
 */
export function agentGlyph(mark: AgentGlyph): GlyphState {
  switch (mark) {
    case "spinner":
      return "working";
    case "waiting":
      return "subagents";
    case "needs-you":
    case "failed":
    case "done":
    case "stopped":
      return mark;
  }
}
