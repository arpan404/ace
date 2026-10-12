import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { setup, identity } from "./remote-test-support.ts";
async function invoke(home: string, args: string[], env: NodeJS.ProcessEnv = {}, stdin = "") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
    { env: { ...process.env, ...env, ACE_HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(stdin);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
test("headless pairing persists a remote profile, hides its token and reads through pinned ticket authentication", async () => {
  const f = await setup();
  const home = await mkdtemp(join(tmpdir(), "ace-cli-remote-"));
  try {
    const pairing = await f.pairing();
    const redeemed = await invoke(
      home,
      ["pair", "redeem", "--profile", "test-host", "--json"],
      {},
      pairing.url,
    );
    expect(redeemed.code, redeemed.stderr).toBe(0);
    expect(JSON.parse(redeemed.stdout)).toMatchObject({
      profile: { name: "test-host", fingerprint: identity.fingerprint },
    });
    expect(JSON.parse(redeemed.stdout)).not.toHaveProperty("profile.token");
    const used = await invoke(home, ["remote", "use", "test-host", "--json"]);
    expect(used.code, used.stderr).toBe(0);
    const threads = await invoke(home, ["threads", "list", "--json"]);
    expect(threads.code, threads.stderr).toBe(0);
    expect(JSON.parse(threads.stdout)).toMatchObject({ threads: expect.any(Array) });
    const listed = await invoke(home, ["remote", "list", "--json"]);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      active: "test-host",
      profiles: [expect.objectContaining({ name: "test-host" })],
    });
    const removed = await invoke(home, ["remote", "remove", "test-host", "--json"]);
    expect(removed.code, removed.stderr).toBe(0);
    const empty = await invoke(home, ["remote", "list", "--json"]);
    expect(JSON.parse(empty.stdout)).toEqual({ active: "local", profiles: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("a remote profile cannot admit credentials under a different server public-key pin", async () => {
  const f = await setup();
  const paired = await f.pair();
  const home = await mkdtemp(join(tmpdir(), "ace-cli-pin-"));
  try {
    await writeFile(join(home, "token"), paired.token, { mode: 0o600 });
    const added = await invoke(home, [
      "remote",
      "add",
      "bad",
      f.server.remoteUrl.replace("wss:", "https:"),
      "--fingerprint",
      "0".repeat(64),
      "--device",
      paired.device.id,
      "--token-file",
      join(home, "token"),
      "--json",
    ]);
    expect(added.code).toBe(4);
    expect(added.stdout).not.toContain(paired.token);
    const profiles = await invoke(home, ["remote", "list", "--json"]);
    expect(JSON.parse(profiles.stdout)).toMatchObject({ profiles: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("cloud submission passes prompt bytes to the installed CLI and retries its receipt without submitting twice", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cli-cloud-"));
  try {
    const native = join(home, "codex");
    const calls = join(home, "calls.jsonl");
    await writeFile(
      native,
      `#!${process.execPath}\nconst fs = require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('synthetic-cloud-task');`,
      { mode: 0o700 },
    );
    const args = [
      "cloud",
      "codex",
      "exec",
      "--env",
      "synthetic-env",
      "--idempotency-key",
      "submit-once",
      "--json",
    ];
    const text = "Keep shell text literal: $(touch /tmp/should-not-exist)";
    const first = await invoke(home, args, { PATH: home }, text);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "ok",
      stdout: "synthetic-cloud-task\n",
      idempotencyKey: "submit-once",
    });
    const retry = await invoke(home, args, { PATH: home }, text);
    expect(retry.code, retry.stderr).toBe(0);
    expect(await readFile(calls, "utf8")).toBe(
      `${JSON.stringify(["cloud", "exec", "--env", "synthetic-env", "--", text])}\n`,
    );
    const changed = await invoke(home, args, { PATH: home }, "Different input");
    expect(changed.code).toBe(4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("log reads return only the requested recent records as valid JSON", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cli-logs-"));
  try {
    await mkdir(join(home, "logs"));
    await writeFile(
      join(home, "logs", "ace.jsonl"),
      ["old", "new", "latest"]
        .map((message) =>
          JSON.stringify({ at: 1, level: "info", component: "synthetic", message, data: null }),
        )
        .join("\n") + "\n",
    );
    const output = await invoke(home, ["logs", "--limit", "2", "--json"]);
    expect(output.code, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject([{ message: "new" }, { message: "latest" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
