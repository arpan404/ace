import { expect, test } from "vitest";
import { blankForm } from "./form.ts";
import { fieldErrors, upcomingLine, upcomingStarts } from "./when.ts";

const now = Date.UTC(2026, 9, 27, 12, 0);

test("an empty name, task and project say what to do, not that a value is wrong", () => {
  const errors = fieldErrors(blankForm("", "Europe/London"));
  expect(errors.title).toBe("Give the automation a name, up to 256 characters.");
  expect(errors.prompt).toBe("Say what the agent should do.");
  expect(errors.workspace).toBe("Choose a project.");
});

test("a schedule's next starts read on its own clock, and a broken one shows none", () => {
  const form = { ...blankForm("/w", "Europe/London"), title: "a", prompt: "b" };
  const starts = upcomingStarts(form, now);
  expect(upcomingLine(starts)).toBe("Next: Tomorrow 9:00 AM, Thursday 9:00 AM, Friday 9:00 AM");
  const broken = { ...form, timezone: "Nowhere/Atlantis" };
  expect(upcomingStarts(broken, now)).toBeUndefined();
  expect(upcomingLine(undefined)).toBe("");
});
