import { replayCursor } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

test("between steps of an open turn the work log says Working for, without a second Working line", async () => {
  const app = harness();
  const script = app.play(replayCursor());
  script.runThrough("worked");
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });

  expect(await within(feed).findByRole("button", { name: /^Working for/ })).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Working" })).toBeNull();

  // Once the agent answers, the log is history: it reads Worked for.
  act(() => script.runThrough("answered"));
  expect(await within(feed).findByRole("button", { name: /^Worked for/ })).toBeTruthy();
});
