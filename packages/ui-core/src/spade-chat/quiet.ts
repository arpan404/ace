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
  | { kind: "checked"; verdict: "done" | "not_yet" | "unchecked"; missing: readonly string[] }
  | { kind: "worker-started"; worker: string; ace: boolean; name: string }
  | {
      kind: "worker-reported";
      worker: string;
      ace: boolean;
      name: string;
      state: Exclude<SpadeWorkerState, "stopping">;
    };

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
    case "worker-started":
      return quiet.ace
        ? line({ kind: "none" }, [plain("Started "), strong(quiet.name)])
        : line({ kind: "face", bot: quiet.worker, pose: "idle" }, [
            plain("Made "),
            strong(quiet.name),
          ]);
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
