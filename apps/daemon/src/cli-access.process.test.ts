import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serviceCommand } from "@ace/service";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

/**
 * The providers-and-access commands against a real daemon on a temp home: every old spelling
 * reaches what its new form reaches, and the machine entry points print what they printed.
 * HOME is an empty folder, so nothing reads the person's own provider homes.
 */
let f: Awaited<ReturnType<typeof daemonFixture>>;
let home: string;
let empty: string;
const run = (args: string[], stdin = "") =>
  invoke(home, args, stdin, { HOME: empty, ACE_MAINTENANCE: "1" });
const json = async (args: string[]) => {
  const output = await run(args);
  expect(output.code, `${args.join(" ")}: ${output.stderr}`).toBe(0);
  return JSON.parse(output.stdout) as unknown;
};

beforeAll(async () => {
  f = await daemonFixture();
  home = join(f.h.home, "daemon");
  empty = await mkdtemp(join(tmpdir(), "ace-cli-access-home-"));
});
afterAll(async () => {
  await f.daemon.close();
  await rm(empty, { recursive: true, force: true });
});

describe("old spellings still work, and reach what the new ones reach", () => {
  test("providers status is provider list", async () => {
    const old = await json(["providers", "status", "--json"]);
    expect(old).toEqual(await json(["provider", "list", "--json"]));
    cliOutputs["provider.list"].parse(old);
  });

  test("capabilities is provider capabilities", async () => {
    const old = cliOutputs["provider.capabilities"].parse(await json(["capabilities", "--json"]));
    const now = cliOutputs["provider.capabilities"].parse(
      await json(["provider", "capabilities", "--json"]),
    );
    expect(Object.keys(old).toSorted()).toEqual(Object.keys(now).toSorted());
    expect(old.providers).toEqual(now.providers);
  });

  test("devices list is device list", async () => {
    const old = cliOutputs["device.list"].parse(await json(["devices", "list", "--json"]));
    expect(old).toEqual(cliOutputs["device.list"].parse(await json(["device", "list", "--json"])));
  });

  test("pair makes a pairing link, as device pair does", async () => {
    cliOutputs["device.pair"].parse(await json(["pair", "--json"]));
    cliOutputs["device.pair"].parse(await json(["device", "pair", "--json"]));
  });

  test("mcp enroll is mcp add, and the grant lists", async () => {
    const added = cliOutputs["mcp.add"].parse(
      await json(["mcp", "enroll", "--scope", "read", "--ttl", "1h", "--json"]),
    );
    const listed = cliOutputs["mcp.list"].parse(await json(["mcp", "list", "--json"]));
    expect(listed.grants.map((grant) => grant.id)).toContain(added.id);
  });

  test("accounts list is provider account list", async () => {
    const old = await json(["accounts", "list", "--json"]);
    expect(old).toEqual(await json(["provider", "account", "list", "--json"]));
  });

  test("machine-code set reaches the daemon as account machine-code set does", async () => {
    const old = await run(["machine-code", "set", "-", "--json"], "481516\n");
    const now = await run(["account", "machine-code", "set", "-", "--json"], "481516\n");
    expect(old.code).not.toBe(64);
    expect(old.code).toBe(now.code);
    expect(JSON.parse(old.stdout)).toEqual(JSON.parse(now.stdout));
  });

  test("login codex and browser shot are the new commands (their help pages say so)", async () => {
    const login = await run(["login", "codex", "--help"]);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain("ace provider login PROVIDER");
    const shot = await run(["browser", "shot", "--help"]);
    expect(shot.code).toBe(0);
    expect(shot.stdout).toContain("ace browser screenshot");
  });

  test("a bare login is still the ace account, never a provider", async () => {
    const help = await run(["login", "--help"]);
    expect(help.stdout).toContain("ace account login");
  });
});

describe("machine entry points stay byte-compatible", () => {
  test("ace version prints one line with the version, and --json the same value", async () => {
    const text = await run(["version"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^\S+\n$/);
    expect(await json(["version", "--json"])).toEqual({ version: text.stdout.trim() });
    expect((await run(["--version"])).stdout).toBe(text.stdout);
  });

  test("ace status --json keeps every field of the daemon's health", async () => {
    const endpoint = (await readFile(join(home, "daemon-endpoint"), "utf8")).trim();
    const token = (await readFile(join(home, "daemon-token"), "utf8")).trim();
    const health = await fetch(new URL("/v1/status", endpoint), {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);
    const status = await json(["status", "--json"]);
    expect(status).toMatchObject({ running: true });
    expect(Object.keys(status as object)).toEqual(expect.arrayContaining(Object.keys(health)));
  });

  test("ace status --json with nothing running is still {running:false}", async () => {
    const down = await mkdtemp(join(tmpdir(), "ace-cli-down-"));
    try {
      const output = await invoke(down, ["status", "--json"], "", { HOME: empty });
      expect(output.code).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({ running: false });
    } finally {
      await rm(down, { recursive: true, force: true });
    }
  });

  test("ace service status --json prints the service module's own answer, unchanged", async () => {
    const output = await run(["service", "status", "--json"]);
    expect(output.code, output.stderr).toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(await serviceCommand(home, ["status"]))}\n`);
  });
});
