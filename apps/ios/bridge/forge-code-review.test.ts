import { expect, test } from "vitest";
import { connected, repository } from "./forge-test-fixture.ts";

/*
 * Reviewing a pull request's code from the phone, on the fake daemon's #245 in acme/ace: four
 * commits (the save bar pushed to after it was viewed), a Markdown guide and a screenshot.
 */

const pull = { project: "ace", number: 245 };
const saveBar = "apps/web/src/features/settings/save-bar.tsx";
const guide = "docs/settings.md";
const hero = "apps/web/public/settings-hero.png";
const first = "c1".padEnd(40, "1");
const described = "c3".padEnd(40, "3");
const settingsPage = "apps/web/src/features/settings/settings-page.tsx";
const section = "apps/web/src/features/settings/section.tsx";

interface Files {
  headSha: string;
  range: { label: string } | null;
  files: { path: string; viewed: string | null; conversations: number }[];
  viewedCount: number | null;
  caveats: string[];
}
interface FileView {
  lines: {
    kind: string;
    hunk: number;
    anchor: { line: number; side: string } | null;
    drafts: { body: string }[];
  }[];
  pairs: [number | null, number | null][];
  commenting: unknown;
  show: string;
  rendered: boolean;
  viewed: string | null;
  headSha: string;
}

test("the Commits list names each commit oldest first, by its first line", async () => {
  const { ask } = await connected();
  const reply = (await ask({ type: "forge.pull.commits", ...pull })) as {
    commits: { sha: string; short: string; title: string; author: string }[];
  };
  expect(reply.commits.map((commit) => commit.title)).toEqual([
    "Group the settings page into sections",
    "Keep the save bar in view",
    "Describe the save bar in the settings guide",
    "Say when there are unsaved changes",
  ]);
  expect(reply.commits[0]).toMatchObject({ sha: first, short: "c111111", author: "you" });
});

test("All commits shows each file's Viewed mark, a file pushed to since as changed", async () => {
  const { ask } = await connected();
  const reply = (await ask({ type: "forge.pull.files", ...pull })) as Files;
  expect(reply.range).toBeNull();
  expect(Object.fromEntries(reply.files.map((file) => [file.path, file.viewed]))).toEqual({
    [settingsPage]: "unviewed",
    [section]: "unviewed",
    [saveBar]: "changed",
    [guide]: "viewed",
    [hero]: "unviewed",
  });
  expect(reply.viewedCount).toBe(1);
  expect(reply.caveats).toEqual([]);
});

test("one commit lists only its files, without marks, conversations or new comments", async () => {
  const { ask } = await connected();
  const range = { commit: described };
  const files = (await ask({ type: "forge.pull.files", ...pull, range })) as Files;
  expect(files.range?.label).toBe("Describe the save bar in the settings guide");
  expect(files.files.map((file) => file.path)).toEqual([guide, hero]);
  expect(files.files.every((file) => file.viewed === null)).toBe(true);
  expect(files.caveats).toEqual(["Viewed marks apply to All commits, not to a single commit."]);
  const file = (await ask({ type: "forge.pull.file", ...pull, path: guide, range })) as FileView;
  expect(file.commenting).toBeNull();
});

test("a span of commits shows what changed after the first commit through the last", async () => {
  const { ask } = await connected();
  const head = ((await ask({ type: "forge.pull.files", ...pull })) as Files).headSha;
  const reply = (await ask({
    type: "forge.pull.files",
    ...pull,
    range: { commit: head, since: first },
  })) as Files;
  expect(reply.range?.label).toBe("3 commits after c111111");
  expect(reply.files.map((file) => file.path).toSorted()).toEqual(
    [hero, saveBar, guide].toSorted(),
  );
});

test("marking a file viewed is sent once at the head, and the list then shows it viewed", async () => {
  const { ask, sent } = await connected();
  const before = (await ask({ type: "forge.pull.files", ...pull })) as Files;
  const outcome = await ask({
    type: "forge.review",
    ...pull,
    repository,
    action: { kind: "file.view", path: saveBar, headSha: before.headSha },
  });
  expect(outcome).toMatchObject({ ok: true, uncertain: false });
  expect(sent.filter((command) => command.type === "forge.hosted.review")).toHaveLength(1);
  const after = (await ask({ type: "forge.pull.files", ...pull, fresh: true })) as Files;
  expect(after.files.find((file) => file.path === saveBar)?.viewed).toBe("viewed");
  expect(after.viewedCount).toBe(2);
});

test("a comment on a span of lines in one change waits under the span's last line", async () => {
  const { ask } = await connected();
  const file = (await ask({ type: "forge.pull.file", ...pull, path: saveBar })) as FileView;
  // Two changes; lines of one change on the new side are numbered without gaps.
  expect(new Set(file.lines.map((line) => line.hunk))).toEqual(new Set([0, 1]));
  const firstChange = file.lines
    .filter((line) => line.hunk === 0 && line.anchor?.side === "RIGHT")
    .map((line) => line.anchor?.line);
  expect(firstChange).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const outcome = await ask({
    type: "forge.review",
    ...pull,
    repository,
    action: {
      kind: "draft.save",
      draft: {
        body: "Name the inset after the keyboard.",
        anchor: {
          commit: file.headSha,
          path: saveBar,
          line: 7,
          side: "RIGHT",
          startLine: 5,
          startSide: "RIGHT",
        },
      },
    },
  });
  expect(outcome).toMatchObject({ ok: true });
  const after = (await ask({
    type: "forge.pull.file",
    ...pull,
    path: saveBar,
    fresh: true,
  })) as FileView;
  const end = after.lines.find((line) => line.anchor?.side === "RIGHT" && line.anchor.line === 7);
  expect(end?.drafts.map((draft) => draft.body)).toEqual(["Name the inset after the keyboard."]);
});

test("side by side, a change's removed and added lines share a row", async () => {
  const { ask } = await connected();
  const file = (await ask({ type: "forge.pull.file", ...pull, path: saveBar })) as FileView;
  const removed = file.lines.findIndex((line) => line.kind === "del");
  const row = file.pairs.find(([left]) => left === removed);
  expect(row?.[1] === null ? undefined : file.lines[row?.[1] ?? -1]?.kind).toBe("add");
});

test("the Markdown guide reads as rendered blocks, its changed paragraphs removed and added", async () => {
  const { ask } = await connected();
  const file = (await ask({ type: "forge.pull.file", ...pull, path: guide })) as FileView;
  expect(file.rendered).toBe(true);
  const reply = (await ask({
    type: "forge.pull.file.sides",
    ...pull,
    path: guide,
    as: "rendered",
  })) as {
    blocks: { kind: string; blocks: { k: string }[] }[];
  };
  expect(reply.blocks.map((block) => block.kind)).toEqual([
    "same",
    "del",
    "add",
    "same",
    "del",
    "add",
    "add",
  ]);
  expect(reply.blocks.at(-1)?.blocks[0]?.k).toBe("alert");
});

test("the screenshot GitHub sends no patch for shows both versions through the daemon", async () => {
  const { ask, reads } = await connected();
  const file = (await ask({ type: "forge.pull.file", ...pull, path: hero })) as FileView;
  expect(file.show).toBe("image");
  const reply = (await ask({
    type: "forge.pull.file.sides",
    ...pull,
    path: hero,
    as: "image",
  })) as {
    before: { state: string; mimeType?: string; data?: string };
    after: { state: string; data?: string };
  };
  expect(reply.before).toMatchObject({ state: "image", mimeType: "image/png" });
  expect(reply.after.state).toBe("image");
  expect(reply.before.data).not.toBe(reply.after.data);
  expect(
    Buffer.from(reply.after.data ?? "", "base64")
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  expect(
    reads.filter((read) => JSON.stringify(read).includes('"op":"forge.file.content"')),
  ).toHaveLength(2);
});
