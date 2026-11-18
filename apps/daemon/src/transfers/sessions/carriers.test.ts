import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionCarrier, SessionNotCarried } from "./index.ts";
import { stageSession } from "./stage.ts";

const id = "0b6f7c1e-1d2a-4c3b-8e9f-1a2b3c4d5e6f";
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
  return out.sort();
}

/** Capture on one home, stage as the final payload would, place in another. */
async function carry(provider: "claude" | "codex", source: string, sourceCwd: string, cwd: string) {
  const carrier = sessionCarrier(provider);
  if (!carrier) throw new Error("no carrier");
  const captured = await carrier.capture({ home: source, nativeSessionId: id });
  const staged = await temp();
  const relative = await stageSession(captured, staged);
  const target = await temp();
  const placed = await carrier.place({
    home: target,
    staged,
    session: { provider, nativeSessionId: id, sourceCwd, files: relative },
    targetCwd: cwd,
  });
  return { placed, target, captured };
}

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
    expect(placed).toEqual({ nativeSessionId: id, action: "resume" });
    expect(await files(target)).toEqual([
      `projects/-home-me-app/${id}.jsonl`,
      `projects/-home-me-app/${id}/subagents/agent-1.jsonl`,
    ]);
    const lines = (
      await readFile(join(target, "projects/-home-me-app", `${id}.jsonl`), "utf8")
    ).split("\n");
    expect(JSON.parse(lines[0] ?? "").cwd).toBe("/home/me/app");
    expect(lines[1]).toBe("not json at all");
    expect(JSON.parse(lines[2] ?? "").cwd).toBe("/home/me/app/web");
    // A sibling folder that only shares a prefix is not inside the checkout.
    expect(JSON.parse(lines[3] ?? "").cwd).toBe("/Users/me/code/application");
    // The rest of a line stays exactly as written, large numbers included.
    expect(lines[4]).toBe(`{"type":"user","cwd":"/home/me/app","big":12345678901234567890}`);
  });

  it("never places over a session the target already has", async () => {
    const home = await temp();
    await put(join(home, "projects", "-a", `${id}.jsonl`), `{"cwd":"/a"}\n`);
    const carrier = sessionCarrier("claude");
    const captured = await carrier!.capture({ home, nativeSessionId: id });
    const staged = await temp();
    const relative = await stageSession(captured, staged);
    const target = await temp();
    await put(join(target, "projects", "-b", `${id}.jsonl`), "theirs\n");
    await expect(
      carrier!.place({
        home: target,
        staged,
        session: { provider: "claude", nativeSessionId: id, sourceCwd: "/a", files: relative },
        targetCwd: "/b",
      }),
    ).rejects.toBeInstanceOf(SessionNotCarried);
    expect(await readFile(join(target, "projects", "-b", `${id}.jsonl`), "utf8")).toBe("theirs\n");
    expect(await files(target)).toEqual([`projects/-b/${id}.jsonl`]);
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

describe("carrying Codex's session to another machine", () => {
  const rollout = (cwd: string) =>
    [
      JSON.stringify({ type: "session_meta", payload: { id, session_id: id, cwd } }),
      JSON.stringify({ type: "turn_context", payload: { cwd, model: "m" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", cwd } }),
      "",
    ].join("\n");

  it("keeps the rollout's place and rewrites the header's and each turn's folder", async () => {
    const home = await temp();
    const path = join("sessions", "2026", "11", "18", `rollout-2026-11-18T10-00-00-${id}.jsonl`);
    await put(join(home, path), rollout("/Users/me/app"));
    await put(join(home, "auth.json"), "{}");
    const { placed, target } = await carry("codex", home, "/Users/me/app", "/srv/app");
    expect(placed).toEqual({ nativeSessionId: id, action: "fork" });
    expect(await files(target)).toEqual([path]);
    const lines = (await readFile(join(target, path), "utf8"))
      .split("\n")
      .map((line) => (line ? JSON.parse(line) : undefined));
    expect(lines[0].payload.cwd).toBe("/srv/app");
    expect(lines[1].payload.cwd).toBe("/srv/app");
    // A record that isn't one Codex keeps its folder in is left alone.
    expect(lines[2].payload.cwd).toBe("/Users/me/app");
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
