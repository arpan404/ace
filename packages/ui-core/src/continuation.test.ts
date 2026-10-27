import { expect, test } from "vitest";
import { continuationAttachmentProblem } from "./continuation.ts";
import type { ModelChoice } from "./models.ts";

const codex = { provider: "codex", model: "GPT-5 Codex" } as Pick<
  ModelChoice,
  "provider" | "model"
> as ModelChoice;

test("a new thread whose model reads only text refuses the message's images by name before sending", () => {
  const problem = continuationAttachmentProblem(
    [{ name: "replay.png" }, { name: "notes.txt", mimeType: "text/plain" }],
    codex,
    ["text"],
  );
  expect(problem).toContain("GPT-5 Codex doesn't read images");
  expect(problem).toContain("replay.png");
  expect(problem).not.toContain("notes.txt");
});

test("files reach a new thread whose model reads images, or reads text only when none are images", () => {
  expect(
    continuationAttachmentProblem([{ name: "replay.png", mimeType: "image/png" }], codex, [
      "text",
      "image",
    ]),
  ).toBeUndefined();
  expect(
    continuationAttachmentProblem([{ name: "report.pdf", mimeType: "application/pdf" }], codex, [
      "text",
    ]),
  ).toBeUndefined();
});
