import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnRawSupervised, type SpawnOptions } from "@ace/provider-kit/process";
import { ProviderLoginSessions } from "@ace/accounts";
import type { ProviderLoginProgress } from "@ace/protocol";
import { apiKeyLoginDriver } from "./provider-api-key.ts";

const sentinel = "opaque-sentinel-credential-that-is-not-a-real-key";
test.each(["codex", "opencode", "cursor"])(
  "%s hands a key only to stdin, discards echoed diagnostics and clears owned buffers",
  async (provider) => {
    const home = await mkdtemp(join(tmpdir(), "ace-key-handoff-"));
    const args =
      provider === "codex"
        ? ["login", "--with-api-key"]
        : provider === "opencode"
          ? ["auth", "login", "--provider", "openai", "--method", "Manually enter API Key"]
          : [];
    const fixture = join(home, "cli.cjs");
    await writeFile(
      fixture,
      `const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/launch.json',JSON.stringify({args:process.argv.slice(2),env:process.env}));${provider === "opencode" ? "process.stdout.write('Enter your API key:');" : ""}let key='';process.stdin.on('data',chunk=>key+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.env.HOME+'/cli-credential',key.trim());console.log(key);console.error(key);});`,
    );
    const events: ProviderLoginProgress[] = [];
    const ready = Promise.withResolvers<void>();
    let submitted: Buffer | undefined;
    const spawns: SpawnOptions[] = [];
    const sessions = new ProviderLoginSessions({
      now: () => 1000,
      id: () => "key-session",
      schedule: () => () => {},
      prepare: async () => {
        const driver = apiKeyLoginDriver({
          command: process.execPath,
          args: [fixture, ...args],
          cwd: home,
          env: { ...process.env, HOME: home },
          prompt: provider === "opencode",
          spawn(options) {
            spawns.push(options);
            return spawnRawSupervised(options);
          },
        });
        return {
          ...driver,
          apiKey(key) {
            submitted = key;
            return driver.apiKey?.(key) ?? false;
          },
        };
      },
    });
    sessions.listen((_owner, progress) => {
      events.push(progress);
      if (progress.state === "awaiting_api_key") ready.resolve();
    });
    try {
      await sessions.handle("owner", {
        type: "provider.login.start",
        requestId: "start",
        provider,
        method: "api_key",
      });
      await ready.promise;
      const request = {
        type: "provider.login.apiKey",
        requestId: "submit",
        session: "key-session",
        apiKey: sentinel,
      };
      await sessions.handle("owner", request);
      const result = await sessions.completed("owner", "key-session");
      expect(result.state).toBe("succeeded");
      expect(await readFile(join(home, "cli-credential"), "utf8")).toBe(sentinel);
      expect(JSON.stringify(spawns)).not.toContain(sentinel);
      expect(await readFile(join(home, "launch.json"), "utf8")).not.toContain(sentinel);
      expect(JSON.stringify(events)).not.toContain(sentinel);
      expect(request.apiKey).toBe("");
      expect(submitted?.every((byte) => byte === 0)).toBe(true);
    } finally {
      await sessions.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("failure diagnostics containing the key return only a fixed failure message and release the account", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-key-failure-"));
  const script = join(home, "failure.cjs");
  await writeFile(
    script,
    "process.stdin.on('data',chunk=>process.stderr.write(chunk));process.stdin.on('end',()=>process.exit(1));",
  );
  const ready = Promise.withResolvers<void>();
  let count = 0;
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `session-${++count}`,
    schedule: () => () => {},
    prepare: async () =>
      apiKeyLoginDriver({
        command: process.execPath,
        args: [script],
        cwd: home,
        env: { ...process.env, HOME: home },
      }),
  });
  sessions.listen((_owner, progress) => {
    if (progress.state === "awaiting_api_key") ready.resolve();
  });
  try {
    await sessions.handle("owner", {
      type: "provider.login.start",
      provider: "codex",
      requestId: "start",
      method: "api_key",
    });
    await ready.promise;
    expect(
      await sessions.handle("stranger", {
        type: "provider.login.apiKey",
        requestId: "wrong-owner",
        session: "session-1",
        apiKey: sentinel,
      }),
    ).toMatchObject({ result: { error: "forbidden" } });
    await sessions.handle("owner", {
      type: "provider.login.apiKey",
      requestId: "submit",
      session: "session-1",
      apiKey: sentinel,
    });
    expect(await sessions.completed("owner", "session-1")).toMatchObject({
      state: "failed",
      message: "Provider authentication could not be completed.",
    });
    expect(sessions.busy("codex")).toBe(false);
    expect(
      await sessions.handle("owner", {
        type: "provider.login.apiKey",
        requestId: "replay",
        session: "session-1",
        apiKey: sentinel,
      }),
    ).toMatchObject({ result: { error: "invalid_input" } });
  } finally {
    await sessions.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("cancelling before key submission closes the session and rejects later credentials", async () => {
  const ready = Promise.withResolvers<void>();
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => "cancel",
    schedule: () => () => {},
    prepare: async () =>
      apiKeyLoginDriver({ command: "must-not-launch", args: [], cwd: tmpdir(), env: {} }),
  });
  sessions.listen((_owner, progress) => {
    if (progress.state === "awaiting_api_key") ready.resolve();
  });
  try {
    await sessions.handle("owner", {
      type: "provider.login.start",
      provider: "codex",
      requestId: "start",
      method: "api_key",
    });
    await ready.promise;
    expect(
      await sessions.handle("owner", {
        type: "provider.login.cancel",
        session: "cancel",
        requestId: "stop",
      }),
    ).toMatchObject({ result: { progress: { state: "cancelled" } } });
    expect(
      await sessions.handle("owner", {
        type: "provider.login.apiKey",
        session: "cancel",
        requestId: "late",
        apiKey: sentinel,
      }),
    ).toMatchObject({ result: { error: "invalid_input" } });
  } finally {
    await sessions.close();
  }
});

test("invalid key requests and rejected hand-offs drop credentials and clear their buffers", async () => {
  const ready = Promise.withResolvers<void>();
  let rejected: Buffer | undefined;
  const finish = Promise.withResolvers<{ success: boolean }>();
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => "reject",
    schedule: () => () => {},
    prepare: async () => ({
      run: async (_signal, emit) => {
        emit({ state: "awaiting_api_key" });
        return finish.promise;
      },
      apiKey(key) {
        rejected = key;
        finish.resolve({ success: false });
        return false;
      },
    }),
  });
  sessions.listen((_owner, progress) => {
    if (progress.state === "awaiting_api_key") {
      ready.resolve();
    }
  });
  try {
    const invalid = {
      type: "provider.login.apiKey",
      requestId: "invalid",
      session: "reject",
      apiKey: sentinel + "\n",
    };
    await expect(sessions.handle("owner", invalid)).rejects.toThrow("Invalid login request");
    expect(invalid.apiKey).toBe("");
    await sessions.handle("owner", {
      type: "provider.login.start",
      provider: "codex",
      requestId: "start",
      method: "api_key",
    });
    await ready.promise;
    expect(
      await sessions.handle("owner", {
        type: "provider.login.apiKey",
        requestId: "submit",
        session: "reject",
        apiKey: sentinel,
      }),
    ).toMatchObject({ result: { error: "invalid_input" } });
    expect(rejected?.every((byte) => byte === 0)).toBe(true);
  } finally {
    finish.resolve({ success: false });
    await sessions.close();
  }
});
