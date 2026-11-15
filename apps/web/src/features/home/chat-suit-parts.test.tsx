import { chatScenario, replayCursor } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/*
 * Chats in the Suit styling contract (docs/design/suit-parts.md): a chat's row in the Chats
 * panel is a `chat-row`, not a `thread-row`, and an open chat is its own page (`data-page=chat`)
 * while a thread stays `thread`.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const lisbon = chatScenario(
  "trip",
  "Three days in Lisbon",
  "claude",
  "Plan three relaxed days in Lisbon.",
  "Alfama, Belém, then Sintra by train.",
);

const pageShown = () => ({
  app: document.querySelector('[data-part="app"]')?.getAttribute("data-page"),
  canvas: document.querySelector('[data-part="page"]')?.getAttribute("data-page"),
});

test("an open chat is a chat page, and its row in the Chats panel is an active chat-row", async () => {
  const app = harness();
  app.play(lisbon).runUntilBlocked();
  await app.open(`/t/${lisbon.thread.id}`);
  await screen.findByRole("heading", { level: 1, name: "Three days in Lisbon" });
  await waitFor(() => expect(pageShown()).toEqual({ app: "chat", canvas: "chat" }));
  const chats = await screen.findByRole("navigation", { name: "Chats" });
  await waitFor(() => {
    const rows = [...chats.querySelectorAll("[data-part]")].map((element) => [
      element.getAttribute("data-part"),
      element.getAttribute("data-state"),
    ]);
    expect(rows).toContainEqual(["chat-row", "active"]);
    expect(rows.map(([part]) => part)).not.toContain("thread-row");
  });
  expect(within(chats).getByText("Three days in Lisbon")).toBeTruthy();
});

test("a thread that isn't a chat stays a thread page", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("answered");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  await waitFor(() => expect(pageShown()).toEqual({ app: "thread", canvas: "thread" }));
});
