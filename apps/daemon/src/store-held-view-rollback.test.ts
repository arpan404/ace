import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Interaction } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
/** Thread A has a pending blocking approval and a held view; B has a cached snapshot. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-held-rollback-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const a = createDevThread(store, workspace);
  const b = createDevThread(store, workspace);
  const approval = Interaction.parse({
    id: "approval",
    threadId: a.id,
    agentId: "root",
    state: "pending",
    createdAt: 1,
    blocking: true,
    request: { kind: "approval", title: "Continue?", options: [] },
  });
  store.appendEvents(a.id, [{ type: "interaction.opened", interaction: approval }]);
  store.snapshotThread(b.id);
  const held = store.acquireThread(a.id);
  cleanup.push(() => store.releaseThread(a.id));
  // Inside a transaction: resolve the approval and read A, which brings the held view up to
  // the transaction's own rows.
  const resolveAndRead = () => {
    store.appendEvents(a.id, [
      { type: "interaction.closed", interactionId: approval.id, state: "resolved", closedAt: 2 },
    ]);
    const inside = store.acquireThread(a.id);
    store.releaseThread(a.id);
    expect(inside.interactions[approval.id]?.state).toBe("resolved");
  };
  const stored = () => {
    // The held object first: whoever holds it reads it without acquiring again.
    const heldState = held.interactions[approval.id]?.state;
    const view = store.acquireThread(a.id);
    store.releaseThread(a.id);
    return {
      held: heldState,
      acquired: view.interactions[approval.id]?.state,
      snapshot: store.snapshotThread(a.id).interactions[approval.id]?.state,
    };
  };
  return { store, resolveAndRead, stored };
}
const stillPending = { held: "pending", acquired: "pending", snapshot: "pending" };

it("a held view read inside a rolled-back transaction shows the stored state afterwards", () => {
  const { store, resolveAndRead, stored } = setup();
  expect(() =>
    store.atomic(() => {
      resolveAndRead();
      throw new Error("rejected");
    }),
  ).toThrow("rejected");
  expect(stored()).toEqual(stillPending);
});

it("a held view read inside a transaction whose commit fails shows the stored state", () => {
  const { store, resolveAndRead, stored } = setup();
  // A deferred foreign key is checked at COMMIT, so the commit itself fails.
  store.statement("CREATE TABLE commit_parent (id TEXT PRIMARY KEY)").run();
  store
    .statement(
      "CREATE TABLE commit_child (parent TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)",
    )
    .run();
  expect(() =>
    store.atomic(() => {
      resolveAndRead();
      store.statement("INSERT INTO commit_child VALUES ('missing')").run();
    }),
  ).toThrow(/FOREIGN KEY/);
  expect(stored()).toEqual(stillPending);
});

it("a held view read inside a rolled-back savepoint shows the stored state after the commit", () => {
  const { store, resolveAndRead, stored } = setup();
  store.atomic(() => {
    expect(() =>
      store.atomic(() => {
        resolveAndRead();
        throw new Error("rejected");
      }),
    ).toThrow("rejected");
  });
  expect(stored()).toEqual(stillPending);
});
