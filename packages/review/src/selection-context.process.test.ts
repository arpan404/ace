import { expect, it } from "vitest";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./test-support.ts";

const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
const changed = original.replace("line 10\n", "changed line 10\n");
async function snapshot(before = original, after = changed) {
  const repo = await repository();
  await repo.write(before);
  await repo.git("add", "file.ts");
  await repo.git("commit", "-qm", "twenty lines");
  await repo.write(after);
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

it.each([
  { side: "old" as const, line: 1, before: [], after: ["line 2", "line 3", "line 4"] },
  { side: "new" as const, line: 1, before: [], after: ["line 2", "line 3", "changed line 4"] },
  { side: "old" as const, line: 20, before: ["line 17", "line 18", "line 19"], after: [] },
  { side: "new" as const, line: 20, before: ["changed line 17", "line 18", "line 19"], after: [] },
])(
  "a selection at $side file boundary line $line is admitted with only the available context",
  async ({ side, line, before, after }) => {
    const unterminated = original.trimEnd();
    const updated = unterminated
      .replace("line 4\n", "changed line 4\n")
      .replace("line 17\n", "changed line 17\n");
    const { repo, session } = await snapshot(unterminated, updated);
    try {
      await repo.write("A newer checkout must not supply boundary context.\n");
      const position = { file: "file.ts", side, start: line, end: line };
      const fingerprint = {
        before,
        lines: [`line ${line}`],
        after,
        ...(line === 20 ? { noFinalNewline: true } : {}),
      };
      const result = await repo.send({
        type: "review.comment",
        sessionId: session.id,
        position,
        expectedFingerprint: fingerprint,
        text: "Keep the boundary selection",
      });
      expect(result.ok).toBe(true);
      const mismatched = await repo.send({
        type: "review.comment",
        sessionId: session.id,
        position,
        expectedFingerprint: { ...fingerprint, lines: ["different boundary text"] },
        text: "Reject stale boundary text",
      });
      expect(mismatched).toMatchObject({ ok: false, error: "review_selection_mismatch" });
      expect(
        (await repo.send({ type: "review.list", sessionId: session.id })).review?.comments,
      ).toEqual([
        expect.objectContaining({
          text: "Keep the boundary selection",
          originalAnchor: expect.objectContaining({
            position,
            fingerprint: expect.objectContaining(fingerprint),
          }),
        }),
      ]);
      expect(await repo.read()).toBe("A newer checkout must not supply boundary context.\n");
    } finally {
      await repo.close();
    }
  },
  30000,
);

it.each([
  { side: "old" as const, file: "file.ts", after: ["line 8", "line 9", "line 10"] },
  { side: "new" as const, file: "renamed.ts", after: ["line 8", "line 9", "changed line 10"] },
])(
  "selection evidence on the $side side of a rename reads that side's immutable path",
  async ({ side, file, after }) => {
    const repo = await repository();
    try {
      await repo.write(original);
      await repo.git("add", "file.ts");
      await repo.git("commit", "-qm", "rename fixture");
      const renamed = join(repo.root, "renamed.ts");
      await rename(join(repo.root, "file.ts"), renamed);
      await writeFile(renamed, changed);
      const opened = await repo.send({
        type: "review.open",
        source: {
          workspaceId: "workspace",
          from: { kind: "commit", ref: "HEAD" },
          to: { kind: "working-tree" },
        },
      });
      const session = opened.review?.session;
      if (!session) throw new Error("No renamed review snapshot");
      await writeFile(renamed, "The live renamed file has changed.\n");
      const position = { file, side, start: 7, end: 7 };
      const fingerprint = { before: ["line 4", "line 5", "line 6"], lines: ["line 7"], after };
      const result = await repo.send({
        type: "review.comment",
        sessionId: session.id,
        position,
        expectedFingerprint: fingerprint,
        text: "Review renamed context",
      });
      expect(result.ok).toBe(true);
      const stale = await repo.send({
        type: "review.comment",
        sessionId: session.id,
        position,
        expectedFingerprint: { ...fingerprint, before: ["wrong line 4", "line 5", "line 6"] },
        text: "Reject stale renamed context",
      });
      expect(stale).toMatchObject({ ok: false, error: "review_selection_mismatch" });
      expect(
        (await repo.send({ type: "review.list", sessionId: session.id })).review?.comments,
      ).toEqual([
        expect.objectContaining({
          text: "Review renamed context",
          originalAnchor: expect.objectContaining({
            position,
            fingerprint: expect.objectContaining({ lines: ["line 7"] }),
          }),
        }),
      ]);
      expect(await readFile(renamed, "utf8")).toBe("The live renamed file has changed.\n");
    } finally {
      await repo.close();
    }
  },
  30000,
);
