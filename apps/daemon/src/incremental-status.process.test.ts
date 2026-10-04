import { expect, test } from "vitest";
import { Interaction, Agent } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";
// Mutation cases: rebuild all active status rows; evict pending work; fail to trim settled
// entities; fail to retain a required ancestor. Not executed (tests run at merge).
test("closing an approval updates the live window without decoding unrelated pending bodies", () => {
  const errors: unknown[] = [];
  const store = new Store(":memory:", (error) => errors.push(error));
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const root = Agent.parse({
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/repo",
      status: { state: "idle" },
      createdAt: 1,
    });
    store.appendEvents(thread.id, [{ type: "agent.created", agent: root }]);
    for (let start = 0; start < 5000; start += 100)
      store.appendEvents(
        thread.id,
        Array.from({ length: 100 }, (_, offset) => ({
          type: "interaction.opened",
          interaction: Interaction.parse({
            id: `pending-${start + offset}`,
            threadId: thread.id,
            agentId: root.id,
            state: "pending",
            createdAt: start + offset,
            blocking: true,
            request: { kind: "approval", title: "Wait", options: [] },
          }),
        })),
      );
    const view = store.acquireThread(thread.id);
    const row = store
      .statement(
        "SELECT value FROM view_entities WHERE collection='interactions' AND id='pending-0'",
      )
      .get();
    if (!row) throw new Error("Missing unrelated approval");
    store
      .statement(
        "UPDATE view_entities SET value='unavailable' WHERE collection='interactions' AND id='pending-0'",
      )
      .run();
    try {
      store.appendEvents(thread.id, [
        {
          type: "interaction.closed",
          interactionId: Interaction.parse({
            id: "pending-1",
            threadId: thread.id,
            agentId: root.id,
            state: "pending",
            createdAt: 1,
            blocking: true,
            request: { kind: "approval", title: "Wait", options: [] },
          }).id,
          state: "resolved",
          closedAt: 6000,
        },
      ]);
      expect(view.interactions["pending-1"]?.state).toBe("resolved");
      expect(view.interactions["pending-0"]?.state).toBe("pending");
      expect(Object.keys(view.interactions)).toHaveLength(5000);
      expect(errors).toEqual([]);
    } finally {
      store
        .statement(
          "UPDATE view_entities SET value=? WHERE collection='interactions' AND id='pending-0'",
        )
        .run(String(row.value));
      store.releaseThread(thread.id);
    }
  } finally {
    store.close();
  }
});

test("an acquired live window keeps pending approvals while thousands of settled entries page out", () => {
  const store = new Store(":memory:");
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const view = store.acquireThread(thread.id);
    for (let index = 0; index < 1000; index++) {
      const interaction = Interaction.parse({
        id: `q-${index}`,
        threadId: thread.id,
        agentId: "root",
        state: "pending",
        createdAt: index,
        blocking: true,
        request: { kind: "approval", title: "Wait", options: [] },
      });
      store.appendEvents(thread.id, [{ type: "interaction.opened", interaction }]);
      if (index > 0)
        store.appendEvents(thread.id, [
          {
            type: "interaction.closed",
            interactionId: interaction.id,
            state: "resolved",
            closedAt: index + 1,
          },
        ]);
    }
    expect(view.interactions["q-0"]?.state).toBe("pending");
    expect(view.interactions["q-999"]?.state).toBe("resolved");
    expect(Object.keys(view.interactions)).toHaveLength(201);
    const before = view.entitiesBefore?.interactions;
    if (before == null) throw new Error("Missing older-entity cursor");
    const page = store.readEntityPage(thread.id, "interactions", before, 200);
    if (page.collection !== "interactions") throw new Error("Wrong collection");
    expect(page.entries.some((entry) => entry.id === "q-799")).toBe(true);
    // A later change in the same publication can reactivate an entry displaced by an earlier change.
    const interaction = (id: string, state: "pending" | "resolved") =>
      Interaction.parse({
        id,
        threadId: thread.id,
        agentId: "root",
        state,
        createdAt: 1001,
        blocking: true,
        request: { kind: "approval", title: "Wait", options: [] },
      });
    store.appendEvents(thread.id, [
      { type: "interaction.opened", interaction: interaction("q-1000", "resolved") },
      { type: "interaction.opened", interaction: interaction("q-800", "pending") },
    ]);
    expect(view.interactions["q-800"]?.state).toBe("pending");
    expect(view.interactions["q-1000"]?.state).toBe("resolved");
    store.releaseThread(thread.id);
  } finally {
    store.close();
  }
});
