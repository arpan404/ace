import { expect, it } from "vitest";
import { repository } from "./test-support.ts";

it.each([
  ["const value = right;", "first\nbefore\nconst value = right;"],
  ["const value = right;\n", "first\nbefore\nconst value = right;\n"],
])(
  "an EOF suggestion preserves or explicitly adds the final newline: %s",
  async (suggestion, expected) => {
    const repo = await repository();
    try {
      await repo.write("first\nbefore\nconst value = wrong;");
      const opened = await repo.send({
        type: "review.open",
        source: { ...repo.session.source, to: { kind: "working-tree" } },
      });
      const sessionId = opened.review?.session?.id;
      const comment = await repo.send({
        type: "review.comment",
        sessionId,
        position: { file: "file.ts", side: "new", start: 3, end: 3 },
        text: "Fix EOF",
        suggestion,
      });
      expect(comment.review?.comment?.anchor.fingerprint.noFinalNewline).toBe(true);
      expect(
        (
          await repo.send({
            type: "review.applySuggestion",
            sessionId,
            commentId: comment.review?.comment?.id,
          })
        ).ok,
      ).toBe(true);
      expect(await repo.read()).toBe(expected);
    } finally {
      await repo.close();
    }
  },
);

it("a suggestion before an unterminated context line preserves that line exactly", async () => {
  const repo = await repository();
  try {
    await repo.write("first\nbefore\nconst value = wrong;\nafter\nlast");
    const opened = await repo.send({
      type: "review.open",
      source: { ...repo.session.source, to: { kind: "working-tree" } },
    });
    const sessionId = opened.review?.session?.id;
    const comment = await repo.send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 3, end: 3 },
      text: "Fix",
      suggestion: "const value = right;",
    });
    expect(
      (
        await repo.send({
          type: "review.applySuggestion",
          sessionId,
          commentId: comment.review?.comment?.id,
        })
      ).ok,
    ).toBe(true);
    expect(await repo.read()).toBe("first\nbefore\nconst value = right;\nafter\nlast");
  } finally {
    await repo.close();
  }
});

it("a human newline edit at the selected EOF conflicts without rewriting the file", async () => {
  const repo = await repository();
  try {
    await repo.write("first\nbefore\nconst value = wrong;");
    const opened = await repo.send({
      type: "review.open",
      source: { ...repo.session.source, to: { kind: "working-tree" } },
    });
    const sessionId = opened.review?.session?.id;
    const comment = await repo.send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 3, end: 3 },
      text: "Fix EOF",
      suggestion: "const value = right;",
    });
    const edited = "first\nbefore\nconst value = wrong;\n";
    await repo.write(edited);
    expect(
      await repo.send({
        type: "review.applySuggestion",
        sessionId,
        commentId: comment.review?.comment?.id,
      }),
    ).toMatchObject({ ok: false, error: "review_suggestion_conflict" });
    expect(await repo.read()).toBe(edited);
  } finally {
    await repo.close();
  }
});

it("deleting the only unterminated line produces an empty file", async () => {
  const repo = await repository();
  try {
    await repo.write("wrong");
    const opened = await repo.send({
      type: "review.open",
      source: { ...repo.session.source, to: { kind: "working-tree" } },
    });
    const sessionId = opened.review?.session?.id;
    const comment = await repo.send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 1, end: 1 },
      text: "Remove",
      suggestion: "",
    });
    expect(
      (
        await repo.send({
          type: "review.applySuggestion",
          sessionId,
          commentId: comment.review?.comment?.id,
        })
      ).ok,
    ).toBe(true);
    expect(await repo.read()).toBe("");
  } finally {
    await repo.close();
  }
});
