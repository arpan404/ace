import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { errorRowText, failedTurnView } from "./failed-turn.ts";

const notice = (fields: Record<string, unknown>) =>
  Item.parse({
    id: "n",
    agentId: "root",
    createdAt: 0,
    type: "notice",
    level: "error",
    complete: true,
    raw: [],
    ...fields,
  });

test("a failed turn names the model before the failure's words, under Turn failed", () => {
  const view = failedTurnView({
    notice: notice({
      text: "The workspace folder is missing",
      detail: "The workspace folder is missing",
    }),
    error: undefined,
    provider: "cursor",
    model: "composer-2.5",
    latest: true,
  });
  const text = errorRowText(view.error, view.heading);
  expect(text.title).toBe("Turn failed");
  expect(text.message).toBe("Composer 2.5 · The workspace folder is missing");
  // Details never repeats what the row already says.
  expect(text.details).toBeUndefined();
});

test("a turn that failed without saying why reads Turn failed alone", () => {
  const view = failedTurnView({
    notice: undefined,
    error: undefined,
    provider: "codex",
    model: undefined,
    latest: true,
  });
  expect(errorRowText(view.error, view.heading)).toEqual({
    title: "Turn failed",
    message: undefined,
    details: undefined,
  });
});

test("a failure the daemon reported on the run reads in its own words, with no Details repeating them", () => {
  const view = failedTurnView({
    notice: undefined,
    error: { kind: "provider_crashed", message: "The provider exited unexpectedly" },
    provider: "claude",
    model: undefined,
    latest: false,
  });
  const text = errorRowText(view.error, view.heading);
  expect(text).toEqual({
    title: "Turn failed",
    message: "The provider exited unexpectedly",
    details: undefined,
  });
  expect(view.fixable).toBe(false);
});
