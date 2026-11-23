import type { SpadeWorkerState } from "./wire-capabilities.ts";

/*
 * The quiet line (docs/design/spade.md §3): one fold-style line in the chat per event that isn't
 * anyone's words: a goal set, a check of done, a worker made or reporting (a request allowed or
 * denied settles to the same line in its card's place). Never a bubble. Each says what happened
 * in a few words, with its one mark or face.
 */

/** An event the chat shows as a quiet line, as the fold keeps it. */
export type SpadeQuiet =
  | { kind: "goal"; title: string }
  /** A step ran on another model of the bot's route, with why (ADR 0205 §2). */
  | { kind: "served"; line: string }
  /** Spade moved the bot off a coding subscription (ADR 0219), in Spade's words. */
  | { kind: "model-replaced"; line: string }
  /** The bot's panel sent an action, or the person confirmed one there (ADR 0200 §5.2). */
  | { kind: "panel-action"; label: string; by: "page" | "person" }
  | { kind: "checked"; verdict: "done" | "not_yet" | "unchecked"; missing: readonly string[] }
  /** One of the bot's task lanes (ADR 0217 §7): started, moved to, sent a message, reporting. */
  | { kind: "lane"; lane: string; title: string; event: SpadeLaneEvent }
  | {
      kind: "worker-reported";
      worker: string;
      ace: boolean;
      name: string;
      state: Exclude<SpadeWorkerState, "stopping">;
    };

/**
 * What a lane's line in main says: it started (or waits for a slot), Spade moved main's long work
 * to it, a person's message was sent to it, or it reported: done, stopped early (failed), stopped,
 * or needs the person.
 */
export type SpadeLaneEvent =
  | "started"
  | "queued"
  | "moved"
  | "routed"
  | "done"
  | "failed"
  | "stopped"
  | "needs_you";

/** A plan mark: met, still being worked on, open, or what waits on the person. */
export type SpadeQuietMark = "done" | "working" | "open";

/** What leads the line: a mark with its label, a worker's face in a pose, or nothing. */
export type SpadeQuietLead =
  | { kind: "mark"; mark: SpadeQuietMark; label: string }
  | { kind: "face"; bot: string; pose: "idle" | "done" | "needs-you" | "blocked" }
  | { kind: "none" };

/** A run of the line's words; `strong` names the thing it is about (the goal, the worker). */
export interface SpadeQuietWords {
  text: string;
  strong?: true;
}

export interface SpadeQuietLine {
  lead: SpadeQuietLead;
  words: readonly SpadeQuietWords[];
  /** The whole line as plain text, for its accessible name. */
  label: string;
}

const strong = (text: string): SpadeQuietWords => ({ text, strong: true });
const plain = (text: string): SpadeQuietWords => ({ text });

const reported: Record<Extract<SpadeQuiet, { kind: "worker-reported" }>["state"], string> = {
  done: " is done",
  finished: " finished",
  needs_you: " needs you",
  parked: " is waiting",
  failed: " failed",
  stopped: " stopped",
  other: " reported",
};

const reportPose = (state: SpadeWorkerState) =>
  state === "done" || state === "finished"
    ? ("done" as const)
    : state === "needs_you"
      ? ("needs-you" as const)
      : state === "failed"
        ? ("blocked" as const)
        : ("idle" as const);

const line = (lead: SpadeQuietLead, words: SpadeQuietWords[]): SpadeQuietLine => ({
  lead,
  words,
  label: words.map((part) => part.text).join(""),
});

export function spadeQuietLine(quiet: SpadeQuiet): SpadeQuietLine {
  switch (quiet.kind) {
    case "served":
    case "model-replaced":
      return line({ kind: "none" }, [plain(quiet.line)]);
    case "panel-action":
      return line({ kind: "none" }, [
        plain(quiet.by === "person" ? "You confirmed " : "The panel sent "),
        strong(quiet.label),
      ]);
    case "goal":
      return line({ kind: "mark", mark: "open", label: "Goal" }, [
        plain("Goal set · "),
        strong(quiet.title || "a goal"),
      ]);
    case "checked":
      if (quiet.verdict === "done")
        return line({ kind: "mark", mark: "done", label: "Done" }, [
          plain("Checked · "),
          strong("done"),
        ]);
      if (quiet.verdict === "not_yet")
        return line({ kind: "mark", mark: "working", label: "Not yet" }, [
          plain("Checked · "),
          strong("not yet"),
          ...(quiet.missing.length ? [plain(`: ${quiet.missing.join(", ")}`)] : []),
        ]);
      return line({ kind: "mark", mark: "open", label: "Not checked" }, [
        plain("Says done, "),
        strong("not checked"),
      ]);
    case "lane":
      return laneLine(quiet.title || "a task", quiet.event);
    case "worker-reported": {
      const words = [
        strong(quiet.name),
        plain(
          quiet.ace && quiet.state === "needs_you"
            ? " needs you in Threads"
            : reported[quiet.state],
        ),
      ];
      return quiet.ace
        ? line({ kind: "none" }, words)
        : line({ kind: "face", bot: quiet.worker, pose: reportPose(quiet.state) }, words);
    }
  }
}

/** A lane's line in main's chat, in Spade's words (ADR 0217 §7). */
function laneLine(title: string, event: SpadeLaneEvent): SpadeQuietLine {
  switch (event) {
    case "started":
    case "queued":
      return line({ kind: "mark", mark: "working", label: "Task" }, [
        plain("Started a task: "),
        strong(title),
      ]);
    case "moved":
      return line({ kind: "mark", mark: "working", label: "Task" }, [
        plain("This is taking a while, so I moved it to its own task: "),
        strong(title),
        plain(". I'm free to talk."),
      ]);
    case "routed":
      return line({ kind: "none" }, [plain("Sent to "), strong(title)]);
    case "done":
      return line({ kind: "mark", mark: "done", label: "Done" }, [
        plain("Task done: "),
        strong(title),
      ]);
    case "failed":
      return line({ kind: "mark", mark: "open", label: "Stopped early" }, [
        plain("Task stopped early: "),
        strong(title),
      ]);
    case "stopped":
      return line({ kind: "mark", mark: "open", label: "Stopped" }, [
        plain("Task stopped: "),
        strong(title),
      ]);
    case "needs_you":
      return line({ kind: "mark", mark: "open", label: "Needs you" }, [
        strong(title),
        plain(" needs you"),
      ]);
  }
}
