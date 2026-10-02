import { expect, it } from "vitest";
import { join } from "node:path";
import { rm, symlink, writeFile, readFile } from "node:fs/promises";
import { repository } from "./test-support.ts";

it("comments and suggestions handle quoted Unicode filenames with spaces", async () => {
  const repo = await repository();
  try {
    const file = 'résumé "value".ts';
    await repo.git("mv", "file.ts", file);
    const opened = await repo.send({
      type: "review.open",
      source: { ...repo.session.source, to: { kind: "working-tree" } },
    });
    const sessionId = opened.review?.session?.id;
    const comment = await repo.send({
      type: "review.comment",
      sessionId,
      position: { file, side: "new", start: 3, end: 3 },
      text: "Fix renamed value",
      suggestion: "const value = right;",
    });
    expect(comment.ok).toBe(true);
    expect(
      (
        await repo.send({
          type: "review.applySuggestion",
          sessionId,
          commentId: comment.review?.comment?.id,
        })
      ).ok,
    ).toBe(true);
    expect(await readFile(join(repo.root, file), "utf8")).toContain("const value = right;");
  } finally {
    await repo.close();
  }
});
it("a conflicting symlink cannot redirect a suggestion outside the repository", async () => {
  const repo = await repository();
  try {
    const comment = await repo.comment("const value = right;");
    const outside = join(repo.directory, "outside.ts");
    const original = "first\nbefore\nconst value = wrong;\nafter\nlast\n";
    await writeFile(outside, original);
    await rm(join(repo.root, "file.ts"));
    await symlink(outside, join(repo.root, "file.ts"));
    expect(
      (
        await repo.send({
          type: "review.applySuggestion",
          sessionId: repo.session.id,
          commentId: comment.id,
        })
      ).ok,
    ).toBe(false);
    expect(await readFile(outside, "utf8")).toBe(original);
  } finally {
    await repo.close();
  }
});
it("sessions review checkpoint ranges and arbitrary commit ranges", async () => {
  const repo = await repository();
  try {
    const checkpointRange = await repo.send({ type: "review.open", source: repo.session.source });
    expect(checkpointRange.review?.session?.source.to).toEqual(repo.session.source.to);
    await repo.git("add", "file.ts");
    await repo.git("commit", "-qm", "agent change");
    const sha = await repo.git("rev-parse", "HEAD");
    const range = await repo.send({
      type: "review.open",
      source: { ...repo.session.source, to: { kind: "commit", ref: sha } },
    });
    const comment = await repo.send({
      type: "review.comment",
      sessionId: range.review?.session?.id,
      position: { file: "file.ts", side: "new", start: 3, end: 3 },
      text: "Committed finding",
    });
    expect(comment.review?.comment?.anchor.fingerprint.lines).toEqual(["const value = wrong;"]);
  } finally {
    await repo.close();
  }
});
