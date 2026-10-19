import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acpLoginDriver } from "./provider-login-acp.ts";
import { signInPages } from "./sign-in-pages.ts";
import { TerminalManager } from "@ace/terminal";
import type { LoginUpdate } from "@ace/accounts";

async function fixture(
  mode: "success" | "waiting" | "unsupported" | "terminal",
  openTerminal?: Parameters<typeof acpLoginDriver>[0]["openTerminal"],
) {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-login-"));
  const command = join(home, "agent");
  const calls = join(home, "calls");
  await writeFile(
    command,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--login-only')) { appendFileSync(${JSON.stringify(calls)}, 'terminal:' + process.env.ACP_INTERACTIVE_LOGIN + ':' + process.argv.slice(2).join(',') + '\\n'); process.exit(0); }
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, req.method + '\\n');
  if (req.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp'},authMethods:${mode === "terminal" ? "[{id:'terminal-login',name:'Sign in',type:'terminal',args:['--login-only'],env:{ACP_INTERACTIVE_LOGIN:'1'}}]" : mode === "unsupported" ? "[{id:'api-key',name:'API key'}]" : "[{id:'oauth-personal',name:'Google account'}]"}}}));
  if (req.method === 'authenticate') {
    console.error('https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&response_type=code&state=challenge');
    console.error('access_token=never-display-this');
    ${mode === "success" ? "console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{}}));" : ""}
  }
});
`,
    { mode: 0o700 },
  );
  const driver = acpLoginDriver({
    provider: "antigravity",
    action: "login",
    command,
    args: ["--configured-base"],
    ...(openTerminal ? { openTerminal } : {}),
    env: { HOME: home, PATH: "" },
    cwd: home,
  });
  return {
    driver,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n"),
    close: async () => {
      await driver.drain?.();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("the installed ACP agent owns browser sign-in and confirms success without raw output or credentials", async () => {
  const f = await fixture("success");
  const updates: LoginUpdate[] = [];
  try {
    expect(
      await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
    ).toEqual({ success: true });
    expect(await f.calls()).toEqual(["initialize", "authenticate"]);
    expect(JSON.stringify(updates)).not.toContain("never-display-this");
    expect(updates.some((update) => update.state === "awaiting_browser")).toBe(true);
  } finally {
    await f.close();
  }
});

test("cancelling browser sign-in drains the actual agent process and never reports success", async () => {
  const f = await fixture("waiting");
  const abort = new AbortController();
  try {
    await expect(
      f.driver.run(abort.signal, (update) => {
        if (update.url) abort.abort();
      }),
    ).rejects.toThrow();
    expect(await f.calls()).toEqual(["initialize", "authenticate"]);
  } finally {
    await f.close();
  }
});

test("an API-key-only agent keeps sign-in unresolved instead of inventing a browser login", async () => {
  const f = await fixture("unsupported");
  const updates: LoginUpdate[] = [];
  try {
    expect(
      await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
    ).toEqual({ success: false });
    expect(await f.calls()).toEqual(["initialize"]);
    expect(updates.at(-1)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("doesn't offer browser sign-in"),
    });
  } finally {
    await f.close();
  }
});

test("terminal authentication runs the configured agent with its advertised arguments and reconnects after a successful exit", async () => {
  const manager = new TerminalManager();
  const f = await fixture("terminal", (launch) => {
    const live = manager.openLiveTerminal(launch, () => {});
    return {
      id: "login-terminal",
      exited: live.exited.then((exit) => exit.code === 0 && exit.signal === null),
      stop: () => manager.releaseLive(live),
    };
  });
  const updates: LoginUpdate[] = [];
  try {
    expect(
      await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
    ).toEqual({ success: true });
    expect(await f.calls()).toEqual([
      "initialize",
      "terminal:1:--configured-base,--login-only",
      "initialize",
    ]);
    expect(updates.some((update) => update.manual?.terminalId === "login-terminal")).toBe(true);
  } finally {
    await f.close();
    await manager.closeAll();
  }
});

const googlePage =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&response_type=code&state=challenge";

/** An installed agent whose sign-in opens a page the way real CLIs do, then waits for it. */
async function opener(options: {
  opens: "open" | "xdg-open" | "BROWSER";
  page: string;
  methods?: unknown[];
}) {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-opener-"));
  const command = join(home, "agent");
  const calls = join(home, "calls");
  const run =
    options.opens === "BROWSER"
      ? "spawn(process.env.BROWSER, [page], { stdio: 'ignore' })"
      : `spawn(${JSON.stringify(options.opens)}, [page], { stdio: 'ignore' })`;
  await writeFile(
    command,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const page = ${JSON.stringify(options.page)};
const methods = ${JSON.stringify(options.methods ?? [{ id: "oauth-personal", name: "Log in with Google" }])};
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, req.method + (req.params?.methodId ? ':' + req.params.methodId : '') + '\\n');
  if (req.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentInfo:{name:'gemini-cli'},authMethods:methods}}));
  if (req.method === 'authenticate') {
    const child = ${run};
    child.on('exit', () => setTimeout(() => console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{}})), 800));
  }
});
`,
    { mode: 0o700 },
  );
  const openedHere: string[] = [];
  const driver = acpLoginDriver({
    provider: "acp",
    action: "login",
    command,
    args: [],
    env: { HOME: home, PATH: "" },
    cwd: home,
    // The real stand-in, with the browser on this computer replaced by a record.
    pages: async (env) => ({
      ...(await signInPages(env, { platform: "linux", root: home })),
      open: (url) => openedHere.push(url),
    }),
  });
  return {
    driver,
    openedHere,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n"),
    close: async () => {
      await driver.drain?.();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test.each(["open", "xdg-open", "BROWSER"] as const)(
  "a sign-in page the agent opens with %s reaches the person's client instead of a browser here",
  async (opens) => {
    const f = await opener({ opens, page: googlePage });
    const updates: LoginUpdate[] = [];
    try {
      expect(
        await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
      ).toEqual({ success: true });
      expect(updates).toContainEqual({ state: "awaiting_browser", url: googlePage });
      expect(f.openedHere).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("a sign-in page ace can't relay opens on this computer and never crosses the wire", async () => {
  const page = "https://example.com/login?session=opaque";
  const f = await opener({ opens: "open", page });
  const updates: LoginUpdate[] = [];
  try {
    expect(
      await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
    ).toEqual({ success: true });
    expect(f.openedHere).toEqual([page]);
    expect(JSON.stringify(updates)).not.toContain("example.com");
  } finally {
    await f.close();
  }
});

test("only methods that finish in the browser are offered: key, Vertex and gateway setups are left out", async () => {
  // Gemini CLI's advertised methods, as its ACP server lists them.
  const f = await opener({
    opens: "open",
    page: googlePage,
    methods: [
      {
        id: "oauth-personal",
        name: "Log in with Google",
        description: "Log in with your Google account",
      },
      {
        id: "gemini-api-key",
        name: "Gemini API key",
        description: "Use an API key with Gemini Developer API",
        _meta: { "api-key": { provider: "google" } },
      },
      {
        id: "vertex-ai",
        name: "Vertex AI",
        description: "Use an API key with Vertex AI GenAI API",
      },
      {
        id: "gateway",
        name: "AI API Gateway",
        description: "Use a custom AI API Gateway",
        _meta: { gateway: { protocol: "google", restartRequired: "false" } },
      },
      { id: "env", name: "Environment", type: "env_var" },
    ],
  });
  const updates: LoginUpdate[] = [];
  try {
    expect(
      await f.driver.run(new AbortController().signal, (update) => updates.push(update)),
    ).toEqual({ success: true });
    // One method left: it signs in without asking which.
    expect(updates.some((update) => update.choices)).toBe(false);
    expect(await f.calls()).toEqual(["initialize", "authenticate:oauth-personal"]);
  } finally {
    await f.close();
  }
});
