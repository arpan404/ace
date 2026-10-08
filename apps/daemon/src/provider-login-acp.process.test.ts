import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acpLoginDriver } from "./provider-login-acp.ts";
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
