import "./test-host.ts";
import { expect, test } from "vitest";
import type { InboxReply, InboxWriteReply } from "./forge-inbox.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * The person's GitHub notifications on the phone, from the fake daemon's GitHub: one of every
 * reason and subject type, across acme/ace, acme/docs-site and acme/billing-api.
 */

type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const inbox = async (ask: Ask, extra: Record<string, unknown> = {}) =>
  (await ask({ type: "forge.inbox", project: "ace", ...extra })) as InboxReply;
const write = async (ask: Ask, action: string, id: string) =>
  (await ask({ type: "forge.inbox.write", project: "ace", action, id })) as InboxWriteReply;

test("unread notifications open pull requests and issues in the app, others on GitHub", async () => {
  const { ask } = await connected();
  const reply = await inbox(ask);
  const byId = new Map(reply.rows.map((row) => [row.id, row]));
  expect(byId.get("9001")).toMatchObject({
    title: "Reconnect the client worker after sleep",
    reason: "Review requested",
    glyph: "pull",
    state: { word: "Open", tone: "done" },
    unread: true,
    opens: { kind: "pull", number: 229, repository: null },
  });
  // Another repository's pull request opens in the app too, naming its repository.
  expect(byId.get("9002")?.opens).toMatchObject({
    kind: "pull",
    number: 31,
    repository: { name: "docs-site" },
  });
  expect(byId.get("9003")?.opens).toMatchObject({ kind: "issue", number: 240 });
  expect(byId.get("9004")).toMatchObject({ glyph: null, opens: null, type: "Workflow run" });
  // Read notifications only show with All.
  expect(byId.has("9008")).toBe(false);
  expect((await inbox(ask, { all: true })).rows.some((row) => row.id === "9008")).toBe(true);
});

test("a reason filter keeps that reason's rows and still offers the others", async () => {
  const { ask } = await connected();
  const reply = await inbox(ask, { reason: "mention" });
  expect(reply.rows.map((row) => row.id)).toEqual(["9002"]);
  expect(reply.reasons.map((reason) => reason.label)).toContain("Review requested");
});

test("marking one read clears its dot and marking one done takes it out of the inbox", async () => {
  const { ask, sent } = await connected();
  expect((await write(ask, "read", "9001")).ok).toBe(true);
  expect((await write(ask, "done", "9003")).ok).toBe(true);
  expect(sent.map((payload) => payload.type === "forge.inbox.write" && payload.input)).toEqual([
    { action: "read", id: "9001" },
    { action: "done", id: "9003" },
  ]);
  const all = await inbox(ask, { all: true });
  expect(all.rows.find((row) => row.id === "9001")?.unread).toBe(false);
  expect(all.rows.some((row) => row.id === "9003")).toBe(false);
});

test("a write GitHub doesn't confirm says so and is sent only once", async () => {
  const { ask, sent, daemon } = await connected();
  daemon.workspace.inbox.setOutcome("uncertain");
  const reply = await write(ask, "done", "9001");
  expect(reply).toMatchObject({ ok: false, uncertain: true });
  expect(reply.message).toContain("sending it again is safe");
  expect(sent).toHaveLength(1);
});
