import { uxAudit } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "@/features/thread/interactions/answers.ts";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

await import("./items/work-log-steps.tsx");

async function openCard(id: string, title: string) {
  const scenario = uxAudit().find((entry) => entry.thread.id === id);
  if (!scenario) throw new Error(`ux audit lost ${id}`);
  const app = harness();
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${id}`);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(region).findByRole("article", { name: title });
  return { app, card, feed: screen.getByRole("feed", { name: "Transcript" }) };
}

test("each option's description reads under its label", async () => {
  const { card } = await openCard("thread-ux-question-pick", "Tabs or Spaces?");
  const tabs = within(card).getByText("Tabs").closest("label");
  expect(tabs?.textContent).toContain("Matches the existing files");
  expect(within(card).getByText("2 spaces, like the web app")).toBeTruthy();
});

test("a question with nothing to pick is one field, and Continue sends the words typed", async () => {
  const { app, card } = await openCard(
    "thread-ux-question-text",
    "What should the config file be called?",
  );
  expect(within(card).queryByRole("radio")).toBeNull();
  const go = within(card).getByRole("button", { name: "Continue" });
  expect(go.hasAttribute("disabled")).toBe(true);
  await userEvent.type(
    within(card).getByRole("textbox", { name: "What should the config file be called?" }),
    "oxfmt.json",
  );
  await userEvent.click(within(card).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(app.daemon.resolution("thread-ux-question-text", "name")).toEqual({
      kind: "question",
      answers: { name: ["oxfmt.json"] },
    }),
  );
});

test("a secret answer is typed hidden and sent as typed, while the transcript shows only dots", async () => {
  const token = "npm_live_7f3a9c";
  const { app, card, feed } = await openCard(
    "thread-ux-question-secret",
    "Paste the npm token for the private registry",
  );
  const field = within(card).getByLabelText("Paste the npm token for the private registry");
  expect(field.getAttribute("type")).toBe("password");
  await userEvent.type(field, `${token}{Enter}`);
  await waitFor(() =>
    expect(app.daemon.resolution("thread-ux-question-secret", "token")).toEqual({
      kind: "question",
      answers: { token: [token] },
    }),
  );
  const line = await within(feed).findByRole("group", {
    name: "Question: Paste the npm token for the private registry",
  });
  await waitFor(() => expect(line.textContent).toContain("••••••••"));
  await userEvent.click(within(line).getByRole("button", { name: "Show the question and answer" }));
  expect(feed.textContent).not.toContain(token);
  // Nothing this device keeps holds the secret.
  expect(JSON.stringify({ ...localStorage })).not.toContain(token);
});
