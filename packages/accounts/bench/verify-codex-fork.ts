/** Opt-in local verification. Creates only synthetic history and never supplies a prompt. */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInstance, migrateSession, instanceEnv } from "../src/index.ts";
import { findExecutable } from "@ace/provider-kit/discovery";

async function* files(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

const root = await mkdtemp(join(tmpdir(), "ace-codex-fork-"));
try {
  const command = await findExecutable("codex");
  if (!command) throw new Error("Codex not installed");
  const from = createInstance({
    id: "from",
    provider: "codex",
    label: "synthetic",
    homeDir: join(root, "from"),
  });
  const to = createInstance({
    id: "to",
    provider: "codex",
    label: "synthetic",
    homeDir: join(root, "to"),
  });
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  const directory = join(from.homeDir, "sessions", "2026", "10", "02");
  await mkdir(directory, { recursive: true });
  for (const [index, id] of ids.entries()) {
    const meta = {
      id,
      session_id: id,
      timestamp: "2026-10-02T10:00:00.000Z",
      cwd: root,
      originator: "ace-synthetic",
      cli_version: "0.159.1",
      source: "cli",
      model_provider: "openai",
      history_mode: "legacy",
      ...(index ? { forked_from_id: ids[index - 1] } : {}),
    };
    await writeFile(
      join(directory, `rollout-2026-10-02T10-00-00-${id}.jsonl`),
      `${JSON.stringify({ timestamp: meta.timestamp, type: "session_meta", payload: meta })}\n${JSON.stringify({ timestamp: meta.timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic history only. This is never sent to the model." }] } })}\n`,
    );
  }
  const nativeSessionId = ids[3];
  if (!nativeSessionId) throw new Error("Missing ID");
  const result = await migrateSession(
    { provider: "codex", nativeSessionId, from, to },
    { acquire: async () => ({ release: async () => {} }) },
  );
  if (result.status !== "migrated") throw new Error(JSON.stringify(result));
  // Bare environment and config disable hooks/network services in the synthetic home.
  const env = instanceEnv(to, { PATH: process.env["PATH"], HOME: root });
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      command,
      [
        "exec",
        "fork",
        nativeSessionId,
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "-c",
        "features.local_thread_store=false",
      ],
      { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Fork-only exited ${code}`);
  let found = false;
  for await (const path of files(join(to.homeDir, "sessions"))) {
    if (ids.some((id) => path.includes(id))) continue;
    const content = await readFile(path, "utf8");
    if (!content.includes(nativeSessionId) || !content.includes("Synthetic history only."))
      throw new Error("Fork lost history or parent identity");
    found = true;
  }
  if (!found) throw new Error("No fork rollout created");
  process.stdout.write(
    "Verified installed Codex fork-only preserved migrated history; no prompt supplied.\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
