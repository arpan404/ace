import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProviderPayload } from "@ace/provider-kit/payload";
import {
  openRegistry,
  createInstance,
  instanceEnv,
  AccountService,
  bindCursorSdk,
} from "./index.ts";
import { ThreadId } from "@ace/protocol";

it("inherits launch authentication only for the SDK backend and keeps registry secrets invalid", async () => {
  const home = await mkdtemp(join(tmpdir(), "account-sdk-"));
  let registry = await openRegistry(join(home, "accounts.sqlite"));
  try {
    const a = createInstance({
      id: "sdk-a",
      provider: "cursor",
      label: "A",
      homeDir: join(home, "a"),
    });
    const b = createInstance({
      id: "sdk-b",
      provider: "cursor",
      label: "B",
      homeDir: join(home, "b"),
    });
    await registry.register(a);
    await registry.register(b);
    const env = { CURSOR_API_KEY: "sentinel-sdk-key", CURSOR_AUTH_TOKEN: "sentinel-cli-token" };
    expect(instanceEnv(a, env, "cursor-sdk")).toMatchObject({
      HOME: join(a.homeDir, "user"),
      CURSOR_API_KEY: "sentinel-sdk-key",
    });
    expect(instanceEnv(a, env, "acp").CURSOR_API_KEY).toBeUndefined();
    expect(instanceEnv(a, env, "cursor-sdk").CURSOR_AUTH_TOKEN).toBeUndefined();
    registry.setCursorSdkAuth(a.id, { status: "logged-in", source: "environment" });
    expect(() =>
      registry.setCursorSdkAuth(a.id, {
        status: "logged-in",
        source: "environment",
        apiKey: "must-not-store",
      }),
    ).toThrow();
    registry.ingest(a.id, {
      provider: "cursor",
      payload: new ProviderPayload('{"auth":"logged_in","usage":{"inputTokens":7}}'),
      observedAt: 1,
      timeZone: "UTC",
    });
    registry.close();
    registry = await openRegistry(join(home, "accounts.sqlite"));
    expect(registry.summary(a.id, 1)?.quota.cursorSdkAuth).toEqual({
      status: "logged-in",
      source: "environment",
    });
    expect(registry.summary(b.id, 1)?.quota.cursorSdkAuth).toBeUndefined();
    expect(JSON.stringify(registry.summaries(1))).not.toContain("sentinel-sdk-key");
    expect(JSON.stringify(registry.summaries(1))).not.toContain("must-not-store");
  } finally {
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("binds two private SDK homes and fences only the selected instance while retaining the other writer", async () => {
  const home = await mkdtemp(join(tmpdir(), "account-sdk-hosts-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  const entry = join(home, "host.mjs");
  await writeFile(
    entry,
    `import { createInterface } from 'node:readline';
const out = (v) => process.stdout.write(JSON.stringify(v)+'\\n');
createInterface({input:process.stdin}).on('line',(line)=>{
 const v=JSON.parse(line);
 out({id:v.id,result:v.method==='open'?{agentId:process.env.HOME}:v.method==='send'?{runId:'synthetic-run'}:{disposed:true}});
});`,
  );
  const service = new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} });
  const bound = bindCursorSdk(service, {
    entry,
    policy: "full-access",
    discovery: {
      platform: "linux",
      arch: "x64",
      nodeVersion: "24.0.0",
      resolve: (id) => (id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json"),
      read: async (path) =>
        path === "/sdk/package.json"
          ? '{"name":"@cursor/sdk","version":"1.0.35"}'
          : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
      executable: async () => {},
    },
  });
  try {
    for (const id of ["a", "b"])
      await registry.register(
        createInstance({ id, provider: "cursor", label: id, homeDir: join(home, id) }),
      );
    const context = (id: string) => ({
      instanceId: id,
      threadId: ThreadId.parse(`thread-${id}`),
      cwd: home,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    });
    const a = await bound.openSession(context("a"));
    const b = await bound.openSession(context("b"));
    expect(a.nativeSessionId).toBe(join(home, "a", "user"));
    expect(b.nativeSessionId).toBe(join(home, "b", "user"));
    await bound.stopInstance("a");
    await expect(a.send([{ type: "text", text: "must not deliver" }], "queue")).rejects.toThrow(
      "closed",
    );
    await expect(bound.openSession(context("a"))).rejects.toThrow("signed out");
    await b.send([{ type: "text", text: "synthetic input" }], "queue");
    expect(
      await service.handle({
        type: "accounts.migrate",
        requestId: "migration",
        provider: "cursor",
        nativeSessionId: b.nativeSessionId,
        from: "b",
        to: "a",
      }),
    ).toMatchObject({
      result: {
        status: "refused",
        reason: "Source or destination has an active writer or migration",
      },
    });
  } finally {
    await bound.close();
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
