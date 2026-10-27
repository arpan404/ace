import { Command } from "@ace/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { changesAction, ChangesAction } from "./changes-actions.ts";
import { openChanges } from "./changes-fixture.ts";
import { plainPreview, until, type RecordingSink } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Sheet = Awaited<ReturnType<typeof openChanges>>;
interface DraftRow {
  key: string;
  state: string;
  text: string;
  error: string | null;
  applied: boolean;
  sent: boolean;
  start: number;
}

async function opened(options: Parameters<typeof openChanges>[0] = {}) {
  const sheet = await openChanges(options);
  closers.push(sheet.close);
  sheet.session.scope("working-tree");
  sheet.session.open("src/replay.ts", true);
  return sheet;
}
let requests = 0;
/** Run a phone action as the native side sends it, and wait for its notice when it has one. */
async function act(sheet: Sheet, raw: Record<string, unknown>) {
  const requestId = `r${++requests}`;
  const action = ChangesAction.parse({ requestId, ...raw });
  expect(changesAction(sheet.session, action, sheet.sink, plainPreview)).toBe(true);
  if (!("requestId" in action)) return undefined;
  await until(() => sheet.sink.read("changes:notice")?.requestId === requestId, raw.kind as string);
  return sheet.sink.read("changes:notice");
}
const review = (sink: RecordingSink) => sink.read("changes:review");
const drafts = (sink: RecordingSink) => review(sink)?.drafts as DraftRow[];
const comment = { kind: "review.draft", path: "src/replay.ts", side: "new", start: 5, end: 5 };

describe("Changes sheet review", () => {
  test("a comment on a diff line is sent to the agent and the review asks for changes", async () => {
    const sheet = await opened();
    expect(await act(sheet, { ...comment, text: "Why change this?" })).toMatchObject({ ok: true });
    expect(review(sheet.sink)).toMatchObject({ pending: 1, open: 0 });
    expect(await act(sheet, { kind: "review.send" })).toMatchObject({ ok: true });
    expect(drafts(sheet.sink)).toEqual([
      expect.objectContaining({ text: "Why change this?", state: "sent", sent: true }),
    ]);
    await act(sheet, { kind: "review.refresh" });
    await until(() => review(sheet.sink)?.refreshing === false, "refresh");
    expect(review(sheet.sink)?.session).toMatchObject({ status: "changes-requested" });
  });

  test("lines that aren't in the diff shown are refused as a draft", async () => {
    const sheet = await opened();
    const notice = await act(sheet, { ...comment, start: 18, end: 18, text: "Here?" });
    expect(notice).toMatchObject({ ok: false });
    expect(String(notice?.message)).toContain("select them again");
    expect(drafts(sheet.sink)).toEqual([]);
  });

  test("drafts come back after a relaunch and a send cut short is offered again", async () => {
    const first = await opened();
    await act(first, { ...comment, text: "Keep me" });
    // The app went away while this send was in flight.
    first.kept.set((all) => all.map((draft) => ({ ...draft, state: "sending" as const })));
    await first.kept.flushed();
    await first.close();
    closers.length = 0;
    const again = await opened({ value: first.value });
    await until(() => drafts(again.sink).length === 1, "kept drafts");
    expect(drafts(again.sink)).toEqual([
      expect.objectContaining({ text: "Keep me", state: "failed", error: expect.any(String) }),
    ]);
    expect(review(again.sink)?.pending).toBe(1);
  });

  test("a sent comment takes replies, resolves and reopens through the daemon", async () => {
    const sheet = await opened();
    await act(sheet, { ...comment, text: "Rename this" });
    await act(sheet, { kind: "review.send" });
    const key = drafts(sheet.sink)[0]?.key;
    expect(
      await act(sheet, { kind: "review.reply", key, text: "Done in the next turn" }),
    ).toMatchObject({
      ok: true,
    });
    expect(sheet.sink.read("changes:replies")).toMatchObject({
      key,
      state: "ready",
      replies: [expect.objectContaining({ text: "Done in the next turn" })],
    });
    await act(sheet, { kind: "review.resolve", key, resolved: true });
    expect(drafts(sheet.sink)[0]).toMatchObject({ state: "resolved" });
    await act(sheet, { kind: "review.resolve", key, resolved: false });
    expect(drafts(sheet.sink)[0]).toMatchObject({ state: "sent" });
  });

  test("applying a suggestion changes the checkout and resolves the comment", async () => {
    const sheet = await opened();
    await act(sheet, { ...comment, text: "Simpler", suggestion: "line 5 simplified" });
    const key = drafts(sheet.sink)[0]?.key;
    expect(await act(sheet, { kind: "review.apply", key })).toMatchObject({ ok: true });
    expect(drafts(sheet.sink)[0]).toMatchObject({ state: "resolved", applied: true, error: null });
    // The same lines now read differently, so a second comment on the old text is refused.
    const lines = sheet.daemon.command(
      Command.parse({
        id: "check",
        deviceId: "other-device",
        payload: {
          type: "review.comment",
          sessionId: "review-1",
          position: { file: "src/replay.ts", side: "new", start: 5, end: 5 },
          expectedFingerprint: { before: [], lines: ["line 5 changed"], after: [] },
          text: "Stale",
        },
      }),
    );
    expect(lines).toMatchObject({ ok: false, error: "review_selection_mismatch" });
  });

  test("approving without comments opens a review of the working tree", async () => {
    const sheet = await opened();
    expect(await act(sheet, { kind: "review.status", status: "approved" })).toMatchObject({
      ok: true,
    });
    expect(review(sheet.sink)?.session).toMatchObject({ status: "approved" });
  });

  test("a comment made on another device appears after a refresh", async () => {
    const sheet = await opened();
    const remote = (id: string, payload: unknown) =>
      sheet.daemon.command(Command.parse({ id, deviceId: "other-device", payload }));
    const open = remote("open", {
      type: "review.open",
      source: {
        workspaceId: "ace",
        threadId: "changes",
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    remote("comment", {
      type: "review.comment",
      sessionId: open.review?.session?.id,
      position: { file: "src/replay.ts", side: "new", start: 4, end: 5 },
      text: "From the laptop",
    });
    await act(sheet, { kind: "review.refresh" });
    await until(() => drafts(sheet.sink).length === 1, "remote comment");
    expect(drafts(sheet.sink)[0]).toMatchObject({ text: "From the laptop", start: 4, sent: true });
  });
});
