import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { ProviderLoginSessions } from "@ace/accounts";
import { openOpenCodeSignIn } from "@ace/adapter-opencode/sign-in";
import type { ProviderLoginProgress } from "@ace/protocol";
import { openCodeLoginDriver } from "./opencode-login-driver.ts";
import { readOpenCodeEarlierLogins } from "./opencode-earlier-logins.ts";

const opencode = fileURLToPath(
  new URL("../../../packages/adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function setup(options: { serverFails?: boolean; authJson?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-browser-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (options.authJson) await writeFile(join(root, "auth.json"), JSON.stringify(options.authJson));
  const log = join(root, "sign-in.log");
  const env = { HOME: root, ACE_TEST_SIGN_IN_LOG: log };
  const events: ProviderLoginProgress[] = [];
  const terminals: string[][] = [];
  const integrations: string[] = [];
  const sessions = new ProviderLoginSessions({
    now: () => 1,
    id: () => "opencode-login",
    schedule: () => () => {},
    prepare: async () =>
      openCodeLoginDriver({
        command: opencode,
        version: "2.0.32",
        cwd: root,
        env,
        action: "login",
        pollMs: 10,
        onIntegration: (id) => integrations.push(id),
        earlierLogins: () => readOpenCodeEarlierLogins(root),
        signIn: (signal) =>
          options.serverFails
            ? Promise.reject(new Error("OpenCode server unavailable"))
            : openOpenCodeSignIn({ command: opencode, env, cwd: root, signal }),
        openTerminal(launch) {
          terminals.push(launch.args ?? []);
          return { id: "opencode-terminal", exited: Promise.resolve(true), stop: async () => {} };
        },
      }),
  });
  cleanups.push(() => sessions.close());
  sessions.listen((_owner, progress) => events.push(progress));
  await sessions.handle("owner", {
    type: "provider.login.start",
    provider: "opencode",
    requestId: "start",
  });
  const choose = async (choice: string) => {
    const offered = events.length;
    await sessions.handle("owner", {
      type: "provider.login.input",
      session: "opencode-login",
      requestId: `choose-${choice}`,
      input: { choice },
    });
    return offered;
  };
  const choices = async () => {
    await expect.poll(() => events.at(-1)?.choices?.length ?? 0).toBeGreaterThan(0);
    return events.at(-1)?.choices ?? [];
  };
  const signInLog = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const done = () => sessions.completed("owner", "opencode-login");
  return { events, terminals, integrations, choose, choices, signInLog, done };
}

test("OpenCode Go signs in with the OpenCode account in ace's dialog, showing its page and code", async () => {
  const f = await setup();
  const offered = await f.choices();
  expect(offered.slice(0, 2)).toEqual([
    { id: "opencode-go", label: "OpenCode Go (OpenCode account)" },
    { id: "opencode", label: "OpenCode Zen (OpenCode account)" },
  ]);
  expect(offered.map((choice) => choice.id)).not.toContain("mcp_fixture");
  expect(offered.at(-1)?.id).toBe("other");
  await f.choose("opencode-go");
  expect((await f.done()).state).toBe("succeeded");
  expect(f.events).toContainEqual(
    expect.objectContaining({
      state: "awaiting_code_entry",
      url: "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli",
      userCode: "ABCD-EFGH",
    }),
  );
  // The hidden server field fills itself; the account integration is the one verified.
  expect(await f.signInLog()).toEqual([
    {
      begin: "opencode",
      body: { methodID: "device", answer: { server: "https://opencode.ai/console" } },
    },
  ]);
  expect(f.integrations).toEqual(["opencode"]);
  expect(f.terminals).toEqual([]);
});

test("GitHub Copilot asks its deployment type in ace, then shows GitHub's device page", async () => {
  const f = await setup();
  await f.choices();
  await f.choose("github-copilot");
  await expect.poll(() => f.events.at(-1)?.prompt).toBe("Select GitHub deployment type");
  expect(f.events.at(-1)?.choices).toEqual([
    { id: "option-0", label: "GitHub.com" },
    { id: "option-1", label: "GitHub Enterprise" },
  ]);
  await f.choose("option-0");
  expect((await f.done()).state).toBe("succeeded");
  expect(f.events).toContainEqual(
    expect.objectContaining({ url: "https://github.com/login/device", userCode: "WXYZ-1234" }),
  );
  expect(await f.signInLog()).toEqual([
    {
      begin: "github-copilot",
      body: { methodID: "device", answer: { deploymentType: "github.com" } },
    },
  ]);
  expect(f.terminals).toEqual([]);
});

test("a field only typing can fill, or a page ace can't show, goes to OpenCode's terminal for that method", async () => {
  const enterprise = await setup();
  await enterprise.choices();
  await enterprise.choose("github-copilot");
  await expect.poll(() => enterprise.events.at(-1)?.prompt).toBeTruthy();
  await enterprise.choose("option-1");
  expect((await enterprise.done()).state).toBe("succeeded");
  expect(enterprise.terminals).toEqual([
    ["auth", "login", "--standalone", "github-copilot", "--method", "device"],
  ]);
  expect(await enterprise.signInLog()).toEqual([]);

  const unknownPage = await setup();
  await unknownPage.choices();
  await unknownPage.choose("poe");
  expect((await unknownPage.done()).state).toBe("succeeded");
  expect(unknownPage.terminals).toEqual([
    ["auth", "login", "--standalone", "poe", "--method", "browser"],
  ]);
  expect(await unknownPage.signInLog()).toEqual([
    { begin: "poe", body: { methodID: "browser" } },
    { cancel: "poe-attempt" },
  ]);
  expect(JSON.stringify(unknownPage.events)).not.toContain("example.com");
});

test("when OpenCode's server can't answer, its terminal picker still signs in", async () => {
  const f = await setup({ serverFails: true });
  const offered = await f.choices();
  expect(offered.map((choice) => choice.id)).toContain("opencode-go");
  await f.choose("anthropic");
  expect((await f.done()).state).toBe("succeeded");
  expect(f.terminals).toEqual([["auth", "login", "--standalone", "anthropic"]]);
});

test("every service OpenCode can sign in to is offered; a key-only one opens OpenCode's terminal aimed at it", async () => {
  const f = await setup();
  const offered = (await f.choices()).map((choice) => choice.id);
  expect(offered).toEqual(expect.arrayContaining(["groq", "wafer.ai", "lmstudio", "anthropic"]));
  // An environment variable is no sign-in; MCP servers aren't model services.
  expect(offered).not.toContain("env-only");
  expect(offered).not.toContain("mcp_fixture");
  expect(offered.at(-1)).toBe("other");
  await f.choose("wafer.ai");
  expect((await f.done()).state).toBe("succeeded");
  expect(f.terminals).toEqual([["auth", "login", "--standalone", "wafer.ai"]]);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      manual: expect.objectContaining({ command: "opencode auth login --standalone wafer.ai" }),
    }),
  );
});

test("a login OpenCode didn't carry over from auth.json leads the list, marked sign in again", async () => {
  const f = await setup({
    authJson: {
      "github-copilot": { type: "oauth", refresh: "r", access: "a", expires: 1 },
      lmstudio: { type: "api", key: "lm-key-never-shown" },
      groq: { type: "api", key: "groq-key-still-connected" },
    },
  });
  const offered = await f.choices();
  const marked = offered.filter((choice) => choice.note === "sign_in_again").map(({ id }) => id);
  // Groq is connected again in OpenCode's store, so only the lost logins are marked.
  expect(marked.toSorted()).toEqual(["github-copilot", "lmstudio"]);
  expect(
    offered
      .slice(2, 4)
      .map(({ id }) => id)
      .toSorted(),
  ).toEqual(["github-copilot", "lmstudio"]);
  expect(JSON.stringify(f.events)).not.toContain("lm-key-never-shown");
});
