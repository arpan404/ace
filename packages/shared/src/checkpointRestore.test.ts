import { describe, expect, it } from "vitest";
import {
  buildCheckpointRestoreConfirmation,
  checkpointRestoreActionTitle,
  checkpointRestoreFailureMessage,
  usesTranscriptRebuildRestore,
} from "./checkpointRestore";

describe("checkpoint restore copy", () => {
  it("uses revert copy for providers that support direct history rewind", () => {
    expect(usesTranscriptRebuildRestore("codex")).toBe(false);
    expect(checkpointRestoreActionTitle("codex")).toBe("Revert to this message");
    expect(checkpointRestoreFailureMessage("codex")).toBe("Failed to revert thread state.");
    expect(buildCheckpointRestoreConfirmation("codex", 3)).toBe(
      [
        "Revert this thread to checkpoint 3?",
        "This will discard newer messages and turn diffs in this thread.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("uses transcript rebuild copy for providers without direct history rewind", () => {
    expect(usesTranscriptRebuildRestore("githubCopilot")).toBe(true);
    expect(checkpointRestoreActionTitle("githubCopilot")).toBe(
      "Restore files and rebuild from this message",
    );
    expect(checkpointRestoreFailureMessage("githubCopilot")).toBe(
      "Failed to restore thread state.",
    );
    expect(buildCheckpointRestoreConfirmation("githubCopilot", 4)).toContain(
      "rebuild context from the saved transcript",
    );
  });
});
