import { nodeBinary } from "@ace/provider-kit/testing";
import { afterEach, expect, test } from "vitest";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  createInstance,
  instanceEnv,
  loginStatus,
  discoverHomes,
  openRegistry,
  addAccount,
} from "./index.ts";
import { temp, cleanup } from "./test-support.ts";
afterEach(cleanup);
const instance = (provider: "codex" | "claude" | "opencode" | "cursor") =>
  createInstance({ id: provider, provider, label: provider, homeDir: `/tmp/${provider}` });

async function fakeClis(root: string) {
  for (const command of ["codex", "claude", "opencode"]) {
    await nodeBinary(
      root,
      command,
      `const fs = require('node:fs');\nconst path = require('node:path');\nconst command = path.basename(process.argv[1]);\nconst args = process.argv.slice(2);\nconst home = command === 'codex' ? process.env.CODEX_HOME : command === 'claude' ? process.env.CLAUDE_CONFIG_DIR : path.join(process.env.XDG_DATA_HOME, 'opencode');\nif (args[0] === '--version') {console.log('2.1.286');}\nelse if (args.includes('login') && !args.includes('status')) {fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'logged-in'),JSON.stringify(args));}\nelse {const yes = fs.existsSync(path.join(home,'logged-in'));console.log(command === 'claude' ? JSON.stringify({loggedIn:yes}) : command === 'opencode' ? (yes ? '1 credential' : '0 credentials') : (yes ? 'Logged in using ChatGPT' : 'Not logged in'));}\n`,
    );
  }
}
test("each provider selects an independent home and strips ambient auth overrides", () => {
  const base = {
    PATH: "/fake",
    OPENAI_API_KEY: "never-persist",
    ANTHROPIC_API_KEY: "never-persist",
    CURSOR_API_KEY: "never-persist",
    OPENCODE_DB: "/shared/db",
  };
  expect(instanceEnv(instance("codex"), base)["CODEX_HOME"]).toBe("/tmp/codex");
  expect(instanceEnv(instance("claude"), base)["CLAUDE_CONFIG_DIR"]).toBe("/tmp/claude");
  expect(instanceEnv(instance("cursor"), base, "cursor-sdk")).toMatchObject({
    HOME: "/tmp/cursor/user",
    USERPROFILE: "/tmp/cursor/user",
    CURSOR_API_KEY: "never-persist",
    CURSOR_DATA_DIR: undefined,
    CURSOR_CONFIG_DIR: undefined,
  });
  expect(instanceEnv(instance("opencode"), base)).toMatchObject({
    XDG_DATA_HOME: "/tmp/opencode/data",
    XDG_CONFIG_HOME: "/tmp/opencode/config",
    XDG_CACHE_HOME: "/tmp/opencode/cache",
    XDG_STATE_HOME: "/tmp/opencode/state",
  });
  for (const provider of ["codex", "claude", "cursor", "opencode"] as const) {
    const env = instanceEnv(instance(provider), base);
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["CURSOR_API_KEY"]).toBeUndefined();
    expect(env["OPENCODE_DB"]).toBeUndefined();
    expect(env["PATH"]).toBe("/fake");
  }
});
test("login discovery sees the selected home rather than another account", async () => {
  const root = await temp();
  await fakeClis(root);
  const discovery = { env: { PATH: root } };
  for (const provider of ["codex", "claude", "opencode"] as const) {
    const a = createInstance({
      id: `${provider}-a`,
      provider,
      label: "a",
      homeDir: join(root, `${provider}-a`),
    });
    const b = createInstance({
      id: `${provider}-b`,
      provider,
      label: "b",
      homeDir: join(root, `${provider}-b`),
    });
    const actualHome = provider === "opencode" ? join(a.homeDir, "data", "opencode") : a.homeDir;
    await mkdir(actualHome, { recursive: true });
    await writeFile(join(actualHome, "logged-in"), "yes");
    const selected = await loginStatus(a, discovery);
    // OpenCode lists configured connections; it does not verify their entitlement.
    expect(selected, provider).toMatchObject(
      provider === "opencode"
        ? { auth: "unknown", authEvidence: "credentials_configured" }
        : { auth: "logged_in" },
    );
    const other = await loginStatus(b, discovery);
    expect(other.auth, provider).toBe("logged_out");
    expect(other.authEvidence, provider).toBeUndefined();
  }
});
test("add launches the CLI login in its own home and persists the resulting status", async () => {
  const root = await temp();
  await fakeClis(root);
  const registry = await openRegistry(join(root, "registry.sqlite"));
  const account = createInstance({
    id: "claude-api",
    provider: "claude",
    label: "API",
    homeDir: join(root, "claude-api"),
  });
  const result = await addAccount(registry, account, {
    now: () => 1234,
    discovery: { env: { PATH: root } },
    mode: "api",
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(join(account.homeDir, "logged-in"), "utf8"))).toEqual([
    "auth",
    "login",
    "--console",
  ]);
  expect(registry.summaries(1234)[0]?.availability).toBe("available");
  expect((await lstat(join(root, "registry.sqlite"))).mode & 0o777).toBe(0o600);
  registry.close();
});
test("discovery finds conventional sibling homes and ignores files and unrelated directories", async () => {
  const root = await temp();
  for (const dir of [
    ".codex",
    ".codex-account2",
    ".claude-max",
    "unrelated",
    ".local/share/opencode",
  ])
    await mkdir(join(root, dir), { recursive: true });
  await mkdir(join(root, ".cursor"));
  await mkdir(join(root, ".cursor-work"));
  const found = await discoverHomes(root);
  expect(found.map((a) => a.id).toSorted()).toEqual([
    "claude-max",
    "codex",
    "codex-account2",
    "opencode-default",
  ]);
  expect(found.find((a) => a.id === "opencode-default")?.env.XDG_DATA_HOME).toBe(
    join(root, ".local/share"),
  );
});
test("registry refuses credential fields, duplicate homes and retargeting an existing identity", async () => {
  const root = await temp();
  const registry = await openRegistry(join(root, "registry.sqlite"));
  const a = createInstance({ id: "a", provider: "codex", label: "a", homeDir: join(root, "home") });
  await registry.register(a);
  await expect(registry.register({ ...a, id: "b" })).rejects.toThrow("distinct");
  await expect(
    registry.register(createInstance({ ...a, homeDir: join(root, "other") })),
  ).rejects.toThrow("cannot change homes");
  const credentialInstance = { ...a, env: { ...a.env, OPENAI_API_KEY: "bad" } };
  await expect(registry.register(credentialInstance)).rejects.toThrow();
  expect(registry.list()).toHaveLength(1);
  registry.close();
});

test("the registry caps account inventory while allowing updates to existing labels", async () => {
  const root = await temp();
  const registry = await openRegistry(join(root, "registry.sqlite"));
  try {
    for (let index = 0; index < 256; index++)
      await registry.register(
        createInstance({
          id: `account-${index}`,
          provider: "codex",
          label: "original",
          homeDir: join(root, `home-${index}`),
        }),
      );
    await expect(
      registry.register(
        createInstance({
          id: "overflow",
          provider: "codex",
          label: "overflow",
          homeDir: join(root, "overflow"),
        }),
      ),
    ).rejects.toThrow("Instance limit exceeded");
    await registry.register(
      createInstance({
        id: "account-0",
        provider: "codex",
        label: "updated",
        homeDir: join(root, "home-0"),
      }),
    );
    expect(registry.summaries(0).find((a) => a.id === "account-0")?.label).toBe("updated");
    expect(registry.get("overflow")).toBeUndefined();
  } finally {
    registry.close();
  }
});

test("checking one account does not execute unrelated provider programs", async () => {
  const root = await temp();
  await fakeClis(root);
  const sentinel = join(root, "unrelated-probe");
  for (const command of ["claude", "opencode"])
    await writeFile(
      join(root, command),
      `#!${process.execPath}\nconst fs = require('node:fs');fs.writeFileSync(${JSON.stringify(sentinel)},'unrelated provider ran');`,
      { mode: 0o755 },
    );
  const account = createInstance({
    id: "codex-only",
    provider: "codex",
    label: "Codex",
    homeDir: join(root, "home"),
  });
  expect((await loginStatus(account, { env: { PATH: root } })).auth).toBe("logged_out");
  await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("account listing identifies the normal CLI home while keeping isolated homes private", async () => {
  const root = await temp();
  const registry = await openRegistry(join(root, "registry.sqlite"));
  try {
    await registry.register({
      ...createInstance({
        id: "codex-default",
        provider: "codex",
        label: "CLI",
        homeDir: join(root, ".codex"),
      }),
      implicit: true,
      env: {},
    });
    await registry.register(
      createInstance({
        id: "codex-work",
        provider: "codex",
        label: "Work",
        homeDir: join(root, "private"),
      }),
    );
    expect(registry.summary("codex-default", 1234)?.cliHome).toBe(join(root, ".codex"));
    expect(JSON.stringify(registry.summary("codex-work", 1234))).not.toContain(
      join(root, "private"),
    );
    expect(JSON.stringify(registry.summaries(1234))).not.toContain('"env"');
  } finally {
    registry.close();
  }
});
