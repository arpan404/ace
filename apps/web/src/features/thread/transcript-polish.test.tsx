import { coldStartReplay, workbench } from "@ace/fake-daemon";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { ModelFacing } from "./items/model-facing.tsx";

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
  const scenario = workbench().find((entry) => entry.thread.id === "thread-ux-failed-commands");
  if (!scenario) throw new Error("Missing failed-commands scenario");
  app.play(scenario).runUntilBlocked();
  await app.open("/t/thread-ux-failed-commands");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  expect(within(feed).getAllByText("Failed")).toHaveLength(1);
  expect(within(feed).queryByText(/exit [01]/)).toBeNull();
  expect(within(feed).getByText("1 failed · 2 retried")).toBeTruthy();
});

test("an account usage warning appears beside the composer without repeating the provider notice in the transcript", async () => {
  const app = harness();
  app.play(coldStartReplay()).runUntilBlocked();
  await app.open("/t/thread-cold-start");
  expect(await screen.findByText("82% of 5-h limit")).toBeTruthy();
  const feed = screen.getByRole("feed", { name: "Transcript" });
  expect(within(feed).queryByText(/has used 82%/)).toBeNull();
  expect(within(feed).queryByText("82% of 5-h limit")).toBeNull();
});
