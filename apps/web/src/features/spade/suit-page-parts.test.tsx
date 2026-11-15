import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

/*
 * Spade's screens name their parts for Suits (ADR 0150, docs/design/suit-parts.md): each bubble
 * says who wrote it and whether it is still being written or failed, faces are avatars, and a
 * bot's page and activity name their header, body and rows.
 */

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "garden", name: "Garden" });
}

/** The Suit part around `text`: the nearest element naming one. */
function partOf(text: HTMLElement) {
  const element = text.closest("[data-part]");
  if (!element) throw new Error(`No part around "${text.textContent}"`);
  return {
    part: element.getAttribute("data-part"),
    state: element.getAttribute("data-state"),
    variant: element.getAttribute("data-variant"),
  };
}

/** The parts this screen is missing from `parts`. */
function missing(parts: readonly string[]): string[] {
  const shown = new Set(
    [...document.querySelectorAll("[data-part]")].map((element) =>
      element.getAttribute("data-part"),
    ),
  );
  return parts.filter((part) => !shown.has(part));
}

test("each bubble says who wrote it, and a reply being written or failed says so", async () => {
  await spadeApp("/spade/garden", (spade) => {
    const garden = seed(spade);
    spade.store(garden.conversation, { type: "user_message", text: "When do I plant garlic?" });
    spade.reply(garden, "In October.");
    spade.store(garden.conversation, { type: "user_message", text: "And onions?" });
    spade.store(garden.conversation, { type: "reply_started", reply: "r-fail" });
    spade.store(garden.conversation, {
      type: "reply_failed",
      reply: "r-fail",
      text: "Onions go",
      error: "stream cut",
      kind: "unreachable",
      endpoint: "openrouter",
    });
    spade.store(garden.conversation, { type: "user_message", text: "Try again" });
    spade.store(garden.conversation, { type: "reply_started", reply: "r-live" });
    spade.store(garden.conversation, {
      type: "reply_progress",
      reply: "r-live",
      text: "Onion sets",
    });
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Garden" }));
  await chat.findByText("Onion sets");
  expect(partOf(chat.getByText("When do I plant garlic?"))).toEqual({
    part: "spade-message",
    state: null,
    variant: "user",
  });
  expect(partOf(chat.getByText("In October."))).toEqual({
    part: "spade-message",
    state: null,
    variant: "bot",
  });
  expect(partOf(chat.getByText("Onions go"))).toMatchObject({ state: "failed", variant: "bot" });
  expect(partOf(chat.getByText("Onion sets"))).toMatchObject({ state: "working", variant: "bot" });
  // The face beside the working line is an avatar, working with it.
  const avatars = [...document.querySelectorAll("[data-part=avatar]")];
  expect(avatars.some((avatar) => avatar.getAttribute("data-state") === "working")).toBe(true);
});

test("Spade's own replies are Spade's, not a bot's", async () => {
  await spadeApp("/spade/main", (spade) => {
    withEndpoint(spade);
    const main = spade.addAgent({
      id: "main",
      kind: "main",
      name: "Spade",
      avatar: { kind: "spade" },
    });
    spade.store(main.conversation, { type: "user_message", text: "Hello" });
    spade.reply(main, "Hi there.");
  });
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Spade" }));
  expect(partOf(await chat.findByText("Hi there."))).toMatchObject({
    part: "spade-message",
    variant: "spade",
  });
});

test("a bot's page names its header, title, toolbar, body and face", async () => {
  await spadeApp("/spade/garden?view=bot", seed);
  const title = await screen.findByRole("heading", { name: "Garden" });
  expect(partOf(title).part).toBe("page-title");
  await waitFor(() =>
    expect(missing(["page-header", "page-title", "page-toolbar", "page-body", "avatar"])).toEqual(
      [],
    ),
  );
});

test("a bot's activity names its filters, and each row's state follows how the step went", async () => {
  await spadeApp("/spade/garden?view=activity", (spade) => {
    seed(spade);
    const at = Date.UTC(2026, 10, 12, 9, 30);
    const entry = (seq: number, fields: Record<string, unknown>) => ({
      id: `${seq}-0`,
      seq,
      at: at + seq * 60_000,
      reply: null,
      cost_micros: null,
      ...fields,
    });
    spade.oversight.activity.set("garden", [
      entry(3, { kind: "tool", name: "web_fetch", summary: "a page", outcome: "error" }),
      entry(2, { kind: "tool", name: "web_search", summary: "a query", outcome: "running" }),
      entry(1, { kind: "tool", name: "web_search", summary: "a query", outcome: "ok" }),
    ]);
  });
  const list = await screen.findByRole("list", { name: "Activity" });
  expect(list.getAttribute("data-part")).toBe("list");
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => [row.getAttribute("data-part"), row.getAttribute("data-state")]),
    ).toEqual([
      ["list-row", "failed"],
      ["list-row", "working"],
      ["list-row", "done"],
    ]),
  );
  expect(missing(["filter-bar", "page-body"])).toEqual([]);
});
