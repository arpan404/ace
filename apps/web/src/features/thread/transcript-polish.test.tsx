import { coldStartReplay, uxAudit } from "@ace/fake-daemon";
import { configure, render, screen, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkLog } from "@/test/open-work-log.ts";
import { ModelFacing } from "./items/model-facing.tsx";

configure({ asyncUtilTimeout: 10000 });

test("received context expands to a readable summary and keeps the envelope behind Details", async () => {
  const envelope = JSON.stringify({
    summary: "The parser keeps unknown provider fields.",
    opaque: { transport: 17 },
  });
  render(<ModelFacing text={envelope} />);
  expect(screen.queryByText("The parser keeps unknown provider fields.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "What the agent received" }));
  expect(screen.getByText("The parser keeps unknown provider fields.")).toBeTruthy();
  const details = screen.getByText("Details").closest("details");
  expect(details?.open).toBe(false);
  await userEvent.click(screen.getByText("Details"));
  expect(details?.open).toBe(true);
  expect(screen.getByText(envelope)).toBeTruthy();
});

test("only a command's final failure is labelled Failed after retries succeed", async () => {
  const app = harness();
  const scenario = uxAudit().find((entry) => entry.thread.id === "thread-ux-failed-commands");
  if (!scenario) throw new Error("Missing failed-commands scenario");
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-ux-failed-commands");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await openWorkLog(feed);
  await within(feed).findByText("Failed");
  expect(within(feed).getAllByText("Failed")).toHaveLength(1);
  expect(within(feed).queryByText(/exit [01]/)).toBeNull();
  // The group counts only the failure no later run fixed.
  expect(within(feed).getByText(/· 1 failed$/)).toBeTruthy();
});

test("an account usage warning stays out of the thread: not in the transcript, not over the composer", async () => {
  const app = harness();
  app.play(coldStartReplay()).runUntilBlocked();
  await app.open("/t/thread-cold-start");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(/replayFrom now treats seq 0 as a cold start/);
  expect(within(feed).queryByText(/has used 82%/)).toBeNull();
  expect(screen.queryByText(/of 5-h limit/)).toBeNull();
});

test("a pending switch to Full access reads as its modes' names on the approvals chip", async () => {
  const app = harness();
  const scenario = uxAudit().find((entry) => entry.thread.id === "thread-ux-pending-full-access");
  if (!scenario) throw new Error("Missing pending-full-access scenario");
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-ux-pending-full-access");
  const chip = await screen.findByRole("button", { name: /^Access: Full access, applies at/ });
  expect(chip.getAttribute("aria-label")).not.toMatch(/Other mode|Unavailable/);
});
