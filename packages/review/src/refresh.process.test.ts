import { expect, it } from "vitest";
import { repository } from "./test-support.ts";

it("a deleted finding retains evidence across refreshes and follows a unique reinsertion", async () => {
  const repo = await repository();
  try {
    const original = await repo.comment();
    const refresh = () =>
      repo.send({
        type: "review.refresh",
        sessionId: repo.session.id,
        from: repo.session.source.from,
        to: { kind: "working-tree" },
      });
    const listed = async () =>
      (await repo.send({ type: "review.list", sessionId: repo.session.id })).review?.comments?.[0];
    await repo.write("first\nbefore\nafter\nlast\n");
    expect((await refresh()).ok).toBe(true);
    expect((await listed())?.anchor).toMatchObject({
      state: "outdated",
      position: original.anchor.position,
      revision: original.anchor.revision,
    });
    await repo.write("inserted\nfirst\nbefore\nafter\nlast\n");
    expect((await refresh()).ok).toBe(true);
    expect((await listed())?.anchor).toMatchObject({
      state: "outdated",
      position: original.anchor.position,
      revision: original.anchor.revision,
    });
    await repo.write("inserted\nfirst\nbefore\nafter\nlast\nconst value = wrong;\n");
    expect((await refresh()).ok).toBe(true);
    const restored = await listed();
    expect(restored?.anchor.position.start).toBe(6);
    expect(restored?.anchor.state).toBe("addressed-pending-review");
    expect(restored?.originalAnchor).toEqual(original.originalAnchor);
    expect(restored?.resolved).toBe(false);
  } finally {
    await repo.close();
  }
});
