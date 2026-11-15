import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { sheetFixture, until } from "./sheet-fixture.ts";
import { NativeSkillLibrary, NativeSkillsRequest } from "./skill-library.ts";

/* Updating a skill installed from a repository, from the phone, on the fake daemon's skills. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

type Reply = Record<string, unknown> & { ok: boolean };
interface Review {
  id: string;
  title: string;
  summary: string;
  baseHash: string;
  folderHash: string;
  files: { path: string; change: string; runnable: string | null }[];
  diff: { additions: number; deletions: number; rows: { kind: string; text: string }[] };
}
async function library() {
  const { daemon, client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const skills = new NativeSkillLibrary(client, () => Date.parse("2026-10-27T12:00:00Z"));
  const ask = async (request: Record<string, unknown>, signal = new AbortController().signal) =>
    (await skills.answer(
      NativeSkillsRequest.parse({ type: "skills.native", ...request }),
      signal,
    )) as Reply;
  /**
   * Asks for a review, and closes its sheet while the machine is still fetching the update:
   * the phone's `service.cancel` aborts the bridge's signal then. The fetch finishes after.
   */
  const closeWhilePreparing = async (skill: string) => {
    const hold = daemon.skills.holdUpdatePreparations();
    const sheet = new AbortController();
    const asked = ask({ op: "prepareUpdate", id: skill }, sheet.signal);
    await until(() => hold.waiting() === 1, "preparing");
    sheet.abort();
    hold.release();
    return asked;
  };
  const listed = (await ask({ op: "library" })) as Reply & {
    groups: { rows: { id: string; name: string }[] }[];
  };
  const id = (name: string) => {
    const row = listed.groups.flatMap((group) => group.rows).find((each) => each.name === name);
    if (!row) throw new Error(`No skill ${name}`);
    return row.id;
  };
  const page = async (skill: string) =>
    (await ask({ op: "skill", id: skill })) as Reply & {
      hash: string;
      body: string;
      description: string;
      source: string | null;
    };
  const review = async (skill: string) => {
    const reply = (await ask({ op: "prepareUpdate", id: skill })) as Reply & { review: Review };
    return reply.review;
  };
  const apply = (skill: string, made: Review, retry = false) =>
    ask({
      op: "applyUpdate",
      id: skill,
      reviewId: made.id,
      expectedHash: made.baseHash,
      folderHash: made.folderHash,
      retry,
    });
  return { ask, closeWhilePreparing, id, page, review, apply };
}

test("a skill from a repository says where it came from, and a check finds its update", async () => {
  const { ask, id, page } = await library();
  const skill = id("frontend-design");
  const source = (await page(skill)).source;
  expect(source).toMatch(/^anthropics\/skills · updated \S/);
  expect(source).not.toMatch(/2026/);
  expect(await ask({ op: "checkUpdate", id: skill })).toEqual({
    ok: true,
    available: true,
    status: "Update available",
  });
});

test("a skill written on the machine has no source, and checking it is refused", async () => {
  const { ask, id, page } = await library();
  const skill = id("research");
  expect((await page(skill)).source).toBeNull();
  expect(await ask({ op: "checkUpdate", id: skill })).toMatchObject({
    ok: false,
    code: "invalid",
  });
});

test("an update's review lists each file, marks what agents may run, and diffs SKILL.md", async () => {
  const { id, review } = await library();
  const made = await review(id("frontend-design"));
  expect(made).toMatchObject({
    title: "Update Frontend design",
    summary: "anthropics/skills · 2 files changed",
    files: [
      { path: "SKILL.md", change: "Changed", runnable: null },
      { path: "scripts/check.sh", change: "Added", runnable: "Agents may run it" },
    ],
  });
  const added = made.diff.rows.filter((row) => row.kind === "add").map((row) => row.text);
  expect(added).toContain("## What's new");
  expect(made.diff.additions).toBe(added.length);
  expect(made.diff.deletions).toBe(0);
});

test("applying the review updates the skill, and the next check says it is up to date", async () => {
  const { ask, id, page, review, apply } = await library();
  const skill = id("frontend-design");
  const before = await page(skill);
  const applied = await apply(skill, await review(skill));
  expect(applied).toMatchObject({ ok: true, notice: "Updated Frontend design" });
  const after = await page(skill);
  expect(applied.hash).toBe(after.hash);
  expect(after.hash).not.toBe(before.hash);
  expect(after.body).toContain("## What's new");
  expect(await ask({ op: "checkUpdate", id: skill })).toMatchObject({
    available: false,
    status: "Up to date",
  });
});

test("an update sent again after its answer was lost says it applied, and applies once", async () => {
  const { id, page, review, apply } = await library();
  const skill = id("frontend-design");
  const made = await review(skill);
  await apply(skill, made);
  const again = await apply(skill, made, true);
  const now = await page(skill);
  expect(again).toMatchObject({ ok: true, hash: now.hash });
  expect(now.body.split("## What's new")).toHaveLength(2);
  // Sent again without saying so, it is refused rather than taken as applied.
  expect(await apply(skill, made)).toMatchObject({ ok: false });
});

test("a review taken before an edit is refused, so the update can't overwrite the edit", async () => {
  const { ask, id, page, review, apply } = await library();
  const skill = id("frontend-design");
  const made = await review(skill);
  const current = await page(skill);
  await ask({
    op: "edit",
    id: skill,
    expectedHash: current.hash,
    description: current.description,
    body: `${current.body}\nMy own note.\n`,
    manual: false,
  });
  expect(await apply(skill, made, true)).toMatchObject({ ok: false, code: "conflict" });
  expect((await page(skill)).body).toContain("My own note.");
});

test("a cancelled review can't be applied any more", async () => {
  const { ask, id, review, apply } = await library();
  const skill = id("frontend-design");
  const made = await review(skill);
  expect(await ask({ op: "cancelUpdate", reviewId: made.id })).toEqual({ ok: true });
  expect(await apply(skill, made)).toMatchObject({ ok: false, code: "not_found" });
});

test("a review that arrives after its sheet closed is let go, so closed sheets use up none", async () => {
  const { closeWhilePreparing, id, review } = await library();
  const skill = id("frontend-design");
  // The machine stages at most eight reviews; each closed sheet's would otherwise hold one.
  for (let closed = 0; closed < 8; closed++)
    expect(await closeWhilePreparing(skill)).toMatchObject({ ok: false });
  expect(await review(skill)).toMatchObject({ title: "Update Frontend design" });
});
