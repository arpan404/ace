import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionCarrier, SessionNotCarried } from "./index.ts";
import { stageSession } from "./stage.ts";

const id = "0b6f7c1e-1d2a-4c3b-8e9f-1a2b3c4d5e6f";
const parent = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";
/** Fresh ids the target hands out, in order. */
const freshA = "11111111-2222-4333-8444-555555555555";
const freshB = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const freshIds = [freshA, freshB];
const generator = (ids = freshIds) => {
  let next = 0;
  return () => ids[next++] ?? `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "ace-carry-"));
  roots.push(root);
  return root;
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name).slice(root.length + 1));
  return out.toSorted();
}

/** Capture on one home, stage as the final payload would, place in another (or the same). */
async function carry(
  provider: "claude" | "codex",
  source: string,
  sourceCwd: string,
  cwd: string,
  options: { into?: string; newId?: () => string } = {},
) {
  const carrier = sessionCarrier(provider);
  if (!carrier) throw new Error("no carrier");
  const captured = await carrier.capture({ home: source, nativeSessionId: id });
  const staged = await temp();
  const relative = await stageSession(captured, staged);
  const target = options.into ?? (await temp());
  const placed = await carrier.place({
    home: target,
    staged,
    session: { provider, nativeSessionId: id, sourceCwd, files: relative },
    targetCwd: cwd,
    newId: options.newId ?? generator(),
  });
  return { placed, target, captured };
}
const records = async (path: string) =>
  (await readFile(path, "utf8")).split("\n").map((line) => (line ? JSON.parse(line) : undefined));

describe("carrying Claude Code's session to another machine", () => {
  it("moves the transcript and its subagents under the new folder with every cwd rewritten", async () => {
    const home = await temp();
    const folder = join(home, "projects", "-Users-me-code-app");
    await put(
      join(folder, `${id}.jsonl`),
      [
        JSON.stringify({ type: "user", sessionId: id, cwd: "/Users/me/code/app", n: 1 }),
        "not json at all",
        JSON.stringify({ type: "assistant", sessionId: id, cwd: "/Users/me/code/app/web" }),
        JSON.stringify({ type: "system", sessionId: id, cwd: "/Users/me/code/application" }),
        `{"type":"user","cwd":"/Users/me/code/app","big":12345678901234567890}`,
        "",
      ].join("\n"),
    );
    await put(join(folder, id, "subagents", "agent-1.jsonl"), `{"cwd":"/Users/me/code/app"}\n`);
    await put(join(home, ".credentials.json"), "secret");
    const { placed, target } = await carry("claude", home, "/Users/me/code/app", "/home/me/app");
    const fresh = freshA;
    expect(placed).toEqual({ nativeSessionId: fresh, action: "resume" });
    expect(await files(target)).toEqual([
      `projects/-home-me-app/${fresh}.jsonl`,
      `projects/-home-me-app/${fresh}/subagents/agent-1.jsonl`,
    ]);
    const lines = (
      await readFile(join(target, "projects/-home-me-app", `${fresh}.jsonl`), "utf8")
    ).split("\n");
    expect(JSON.parse(lines[0] ?? "").cwd).toBe("/home/me/app");
    expect(lines[1]).toBe("not json at all");
    expect(JSON.parse(lines[2] ?? "").cwd).toBe("/home/me/app/web");
    // A sibling folder that only shares a prefix is not inside the checkout.
    expect(JSON.parse(lines[3] ?? "").cwd).toBe("/Users/me/code/application");
    // The rest of a line stays exactly as written, large numbers included.
    expect(lines[4]).toBe(`{"type":"user","cwd":"/home/me/app","big":12345678901234567890}`);
  });

  it("places a session the target already holds under a fresh id, every reference renamed", async () => {
    // A return trip: the home already holds the original, at the same folder and id.
    const home = await temp();
    const folder = join(home, "projects", "-a");
    const original = [
      JSON.stringify({ type: "user", sessionId: id, cwd: "/a", uuid: "u1" }),
      `{"type":"assistant","sessionId":"${id.toUpperCase()}","cwd":"/a","big":12345678901234567890}`,
      "kept as written",
      JSON.stringify({ type: "summary", leafUuid: "u1", note: `talked about "${id}` }),
      "",
    ].join("\n");
    await put(join(folder, `${id}.jsonl`), original);
    const sidechain = `${JSON.stringify({ sessionId: id, agentId: "x", isSidechain: true })}\n`;
    await put(join(folder, id, "subagents", "agent-x.jsonl"), sidechain);
    const fresh = freshA;
    const { placed } = await carry("claude", home, "/a", "/a", { into: home });
    expect(placed).toEqual({ nativeSessionId: fresh, action: "resume" });
    expect(await files(home)).toEqual([
      `projects/-a/${id}.jsonl`,
      `projects/-a/${id}/subagents/agent-x.jsonl`,
      `projects/-a/${fresh}.jsonl`,
      `projects/-a/${fresh}/subagents/agent-x.jsonl`,
    ]);
    // The original is untouched.
    expect(await readFile(join(folder, `${id}.jsonl`), "utf8")).toBe(original);
    expect(await readFile(join(folder, id, "subagents", "agent-x.jsonl"), "utf8")).toBe(sidechain);
    const copy = (await readFile(join(folder, `${fresh}.jsonl`), "utf8")).split("\n");
    expect(JSON.parse(copy[0] ?? "")).toEqual({
      type: "user",
      sessionId: fresh,
      cwd: "/a",
      uuid: "u1",
    });
    // Renamed in place, in any case, with the rest of the line exactly as written.
    expect(copy[1]).toBe(
      `{"type":"assistant","sessionId":"${fresh}","cwd":"/a","big":12345678901234567890}`,
    );
    expect(copy[2]).toBe("kept as written");
    // Text that only mentions the id is not a reference to it.
    expect(copy[3]).toBe(
      JSON.stringify({ type: "summary", leafUuid: "u1", note: `talked about "${id}` }),
    );
    expect(
      JSON.parse(await readFile(join(folder, fresh, "subagents", "agent-x.jsonl"), "utf8")),
    ).toEqual({ sessionId: fresh, agentId: "x", isSidechain: true });
  });

  it("still never places over a file the target already has", async () => {
    const home = await temp();
    await put(join(home, "projects", "-a", `${id}.jsonl`), `{"cwd":"/a"}\n`);
    const target = await temp();
    const fresh = freshA;
    await put(join(target, "projects", "-b", `${fresh}.jsonl`), "theirs\n");
    await expect(carry("claude", home, "/a", "/b", { into: target })).rejects.toBeInstanceOf(
      SessionNotCarried,
    );
    expect(await readFile(join(target, "projects", "-b", `${fresh}.jsonl`), "utf8")).toBe(
      "theirs\n",
    );
    expect(await files(target)).toEqual([`projects/-b/${fresh}.jsonl`]);
  });

  it("refuses a missing session, which falls back to the summary", async () => {
    await expect(
      sessionCarrier("claude")!.capture({ home: await temp(), nativeSessionId: id }),
    ).rejects.toBeInstanceOf(SessionNotCarried);
  });

  it("refuses a checkout whose folder name is longer than Claude keeps", async () => {
    const home = await temp();
    await put(join(home, "projects", "-a", `${id}.jsonl`), `{"cwd":"/a"}\n`);
    await expect(carry("claude", home, "/a", `/${"x".repeat(240)}`)).rejects.toBeInstanceOf(
      SessionNotCarried,
    );
  });
});

const rollout = (cwd: string, meta: Record<string, unknown> = {}) =>
  [
    JSON.stringify({ type: "session_meta", payload: { id, session_id: id, cwd, ...meta } }),
    JSON.stringify({ type: "turn_context", payload: { cwd, model: "m" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", cwd } }),
    "",
  ].join("\n");

describe("carrying Codex's session to another machine", () => {
  it("keeps the rollout's place and rewrites the header's and each turn's folder", async () => {
    const home = await temp();
    const path = join("sessions", "2026", "11", "18", `rollout-2026-11-18T10-00-00-${id}.jsonl`);
    await put(join(home, path), rollout("/Users/me/app"));
    await put(join(home, "auth.json"), "{}");
    const { placed, target } = await carry("codex", home, "/Users/me/app", "/srv/app");
    const fresh = freshA;
    expect(placed).toEqual({ nativeSessionId: fresh, action: "fork" });
    const moved = join(
      "sessions",
      "2026",
      "11",
      "18",
      `rollout-2026-11-18T10-00-00-${fresh}.jsonl`,
    );
    expect(await files(target)).toEqual([moved]);
    const copy = await records(join(target, moved));
    expect(copy[0].payload).toMatchObject({ id: fresh, session_id: fresh, cwd: "/srv/app" });
    expect(copy[1].payload.cwd).toBe("/srv/app");
    // A record that isn't one Codex keeps its folder in is left alone.
    expect(copy[2].payload.cwd).toBe("/Users/me/app");
  });

  it("places a lineage the home already holds under fresh ids, forks pointing at the copies", async () => {
    // Two daemons sharing one ~/.codex: the rollout and the one it forks from are both there.
    const home = await temp();
    const day = join("sessions", "2026", "11", "18");
    const parentPath = join(day, `rollout-2026-11-18T09-00-00-${parent}.jsonl`);
    const childPath = join(day, `rollout-2026-11-18T10-00-00-${id}.jsonl`);
    const parentText = [
      JSON.stringify({ type: "session_meta", payload: { id: parent, cwd: "/app" } }),
      "",
    ].join("\n");
    const childText = rollout("/app", {
      forked_from_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    });
    await put(join(home, parentPath), parentText);
    await put(join(home, childPath), childText);
    const { placed } = await carry("codex", home, "/app", "/app", { into: home });
    // The ancestor is visited first, so it takes the first fresh id.
    const [freshParent, freshChild] = [freshA, freshB];
    expect(placed).toEqual({ nativeSessionId: freshChild, action: "fork" });
    const parentCopy = join(day, `rollout-2026-11-18T09-00-00-${freshParent}.jsonl`);
    const childCopy = join(day, `rollout-2026-11-18T10-00-00-${freshChild}.jsonl`);
    expect(await files(home)).toEqual([parentPath, childPath, parentCopy, childCopy].toSorted());
    expect(await readFile(join(home, parentPath), "utf8")).toBe(parentText);
    expect(await readFile(join(home, childPath), "utf8")).toBe(childText);
    expect((await records(join(home, parentCopy)))[0].payload.id).toBe(freshParent);
    const child = await records(join(home, childCopy));
    expect(child[0].payload).toEqual({
      id: freshChild,
      session_id: freshChild,
      cwd: "/app",
      forked_from_id: freshParent,
      source: { subagent: { thread_spawn: { parent_thread_id: freshParent, depth: 1 } } },
    });
    // The copy's lineage reads back whole from the home, through the fresh ids alone.
    const again = await sessionCarrier("codex")!.capture({ home, nativeSessionId: freshChild });
    expect(again.files.map((file) => file.relative).toSorted()).toEqual(
      [parentCopy, childCopy].toSorted(),
    );
  });

  it("doesn't carry a compressed rollout", async () => {
    const home = await temp();
    await put(join(home, "sessions", "2026", "11", "18", `rollout-x-${id}.jsonl.zst`), "zz");
    await expect(
      sessionCarrier("codex")!.capture({ home, nativeSessionId: id }),
    ).rejects.toBeInstanceOf(SessionNotCarried);
  });
});

describe("providers whose sessions aren't carried", () => {
  it.each(["opencode", "pi", "cursor", "acp"] as const)("%s continues from the summary", (kind) => {
    expect(sessionCarrier(kind)).toBeUndefined();
  });
});
