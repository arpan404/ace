import { expect, it } from "vitest";
import { repository } from "./test-support.ts";

const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const changed = original.replace("line 10\n", "changed line 10\n");
async function snapshot() {
  const repo = await repository();
  await repo.write(original);
  await repo.git("add", "file.ts");
  await repo.git("commit", "-qm", "twenty lines");
  await repo.write(changed);
  const opened = await repo.send({
    type: "review.open",
    source: {
      workspaceId: "workspace",
      from: { kind: "commit", ref: "HEAD" },
      to: { kind: "working-tree" },
    },
  });
  const session = opened.review?.session;
  if (!session) throw new Error("No review snapshot");
  return { repo, session };
}

it.each([
  {
    side: "old" as const,
    line: 7,
    before: ["line 4", "line 5", "line 6"],
    after: ["line 8", "line 9", "line 10"],
  },
  {
    side: "new" as const,
    line: 7,
    before: ["line 4", "line 5", "line 6"],
    after: ["line 8", "line 9", "changed line 10"],
  },
  {
    side: "old" as const,
    line: 13,
    before: ["line 10", "line 11", "line 12"],
    after: ["line 14", "line 15", "line 16"],
  },
  {
    side: "new" as const,
    line: 13,
    before: ["changed line 10", "line 11", "line 12"],
    after: ["line 14", "line 15", "line 16"],
  },
])(
  "a comment on $side line $line checks folded context against its immutable file instead of the clipped Git hunk",
  async ({ side, line, before, after }) => {
    const { repo, session } = await snapshot();
    try {
      // A live-file read would be wrong even though both immutable sides still match the UI.
      await repo.write("The checkout changed after the review opened.\n");
      const result = await repo.send({
        type: "review.comment",
        sessionId: session.id,
        position: { file: "file.ts", side, start: line, end: line },
        expectedFingerprint: { before, lines: [`line ${line}`], after },
        text: "Review the visible context line",
      });
      expect(result.ok).toBe(true);
      expect(
        (await repo.send({ type: "review.list", sessionId: session.id })).review?.comments,
      ).toEqual([
        expect.objectContaining({
          text: "Review the visible context line",
          originalAnchor: expect.objectContaining({
            position: { file: "file.ts", side, start: line, end: line },
            fingerprint: expect.objectContaining({ lines: [`line ${line}`] }),
          }),
        }),
      ]);
      expect(await repo.read()).toBe("The checkout changed after the review opened.\n");
    } finally {
      await repo.close();
    }
  },
  30000,
);

it("different context outside the Git hunk refuses a comment before storing it", async () => {
  const { repo, session } = await snapshot();
  try {
    const result = await repo.send({
      type: "review.comment",
      sessionId: session.id,
      position: { file: "file.ts", side: "new", start: 7, end: 7 },
      expectedFingerprint: {
        before: ["different line 4", "line 5", "line 6"],
        lines: ["line 7"],
        after: ["line 8", "line 9", "changed line 10"],
      },
      text: "A stale context must not be admitted",
    });
    expect(result).toMatchObject({ ok: false, error: "review_selection_mismatch" });
    expect(
      (await repo.send({ type: "review.list", sessionId: session.id })).review?.comments,
    ).toEqual([]);
    expect(await repo.read()).toBe(changed);
  } finally {
    await repo.close();
  }
}, 30000);
