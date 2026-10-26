import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  addAccount,
  createInstance,
  migrateSession,
  openRegistry,
  runAccountsCommand,
} from "./index.ts";
import { cleanup, hash, homes, ids, idle, put, rollout, temp } from "./test-support.ts";
afterEach(cleanup);

// Windows: every provider CLI finds its home under USERPROFILE (Node's `os.homedir()`, Rust's
// profile folder), never under a HOME that Git Bash or MSYS sets.
const windows = process.platform === "win32";

test.runIf(windows)(
  "Windows: discover lists the CLI homes in the profile folder, not in a Git Bash HOME",
  async () => {
    const root = await temp();
    const profile = join(root, "Users", "person");
    const bashHome = join(root, "msys", "home", "person");
    for (const dir of [".claude", ".codex", ".codex-work", join(".local", "share", "opencode")])
      await mkdir(join(profile, dir), { recursive: true });
    await mkdir(join(bashHome, ".claude-bash"), { recursive: true });
    const output: string[] = [];
    await runAccountsCommand(["accounts", "discover"], {
      env: {
        USERPROFILE: profile,
        HOME: bashHome,
        ACE_HOME: join(root, "ace-data"),
        ACE_ACCOUNTS_DB: join(root, "accounts.sqlite"),
      },
      platform: "win32",
      write: (text) => output.push(text),
    });
    const found = output.map((line) =>
      z
        .object({ id: z.string(), homeDir: z.string(), env: z.record(z.string(), z.string()) })
        .parse(JSON.parse(line)),
    );
    expect(found.map((a) => a.id).toSorted()).toEqual([
      "claude",
      "codex",
      "codex-work",
      "opencode-default",
    ]);
    expect(found.find((a) => a.id === "codex-work")?.env).toEqual({
      CODEX_HOME: join(profile, ".codex-work"),
    });
    // OpenCode's xdg-basedir roots are the same on Windows, under the profile folder.
    expect(found.find((a) => a.id === "opencode-default")).toMatchObject({
      homeDir: join(profile, ".local", "share", "opencode"),
      env: {
        XDG_DATA_HOME: join(profile, ".local", "share"),
        XDG_CONFIG_HOME: join(profile, ".config"),
        XDG_STATE_HOME: join(profile, ".local", "state"),
        XDG_CACHE_HOME: join(profile, ".cache"),
      },
    });
  },
);

// npm installs each CLI as a `.cmd` shim. This one records the environment it signed in with
// inside the home its selector names, the way the real CLI keeps its login there.
async function windowsClis(root: string) {
  const script = join(root, "cli.js");
  await writeFile(
    script,
    `const fs = require('node:fs');
const path = require('node:path');
const command = process.env.ACE_FAKE_CLI;
const args = process.argv.slice(2);
const home = command === 'codex' ? process.env.CODEX_HOME : command === 'claude' ? process.env.CLAUDE_CONFIG_DIR : path.join(process.env.XDG_DATA_HOME, 'opencode');
const seen = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ANTHROPIC_API_KEY'];
if (args[0] === '--version') console.log('2.1.286');
else if (args.includes('login') && !args.includes('status')) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'logged-in'), JSON.stringify({ args, env: Object.fromEntries(seen.map((k) => [k, process.env[k] ?? null])) }));
} else {
  const yes = fs.existsSync(path.join(home, 'logged-in'));
  console.log(command === 'claude' ? JSON.stringify({ loggedIn: yes }) : command === 'opencode' ? JSON.stringify(yes ? [{ id: 'openai', connections: [{ type: 'credential' }] }] : []) : (yes ? 'Logged in using ChatGPT' : 'Not logged in'));
}
`,
  );
  for (const command of ["claude", "codex", "opencode"])
    await writeFile(
      join(root, `${command}.cmd`),
      `@echo off\r\nset ACE_FAKE_CLI=${command}\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
}

test.runIf(windows)(
  "Windows: adding an account signs in through the CLI's .cmd shim inside its own home and keeps the person's profile folders",
  async () => {
    const root = await temp();
    const bin = join(root, "bin");
    await mkdir(bin);
    await windowsClis(bin);
    const profile = join(root, "Users", "person");
    const person = {
      ...process.env,
      PATH: `${bin};${process.env.PATH ?? ""}`,
      USERPROFILE: profile,
      APPDATA: join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: join(profile, "AppData", "Local"),
      ANTHROPIC_API_KEY: "person-key",
      XDG_CONFIG_HOME: undefined,
      GH_CONFIG_DIR: undefined,
    };
    const registry = await openRegistry(join(root, "accounts.sqlite"));
    try {
      for (const provider of ["claude", "codex", "opencode"] as const) {
        const account = createInstance({
          id: `${provider}-work`,
          provider,
          label: "Work",
          homeDir: join(root, "homes", `${provider}-work`),
        });
        const result = await addAccount(registry, account, {
          now: () => 1,
          discovery: { env: person },
        });
        expect(result.code, provider).toBe(0);
        expect(result.status, provider).toMatchObject(
          provider === "opencode"
            ? { authEvidence: "credentials_configured" }
            : { auth: "logged_in" },
        );
        const login = join(
          provider === "opencode" ? join(account.homeDir, "data", "opencode") : account.homeDir,
          "logged-in",
        );
        const signedIn = z
          .object({ env: z.record(z.string(), z.string().nullable()) })
          .parse(JSON.parse(await readFile(login, "utf8")));
        expect(signedIn.env, provider).toMatchObject({
          USERPROFILE: profile,
          APPDATA: person.APPDATA,
          LOCALAPPDATA: person.LOCALAPPDATA,
          ANTHROPIC_API_KEY: null,
          ...(provider === "claude" ? { CLAUDE_CONFIG_DIR: account.homeDir } : {}),
          ...(provider === "codex" ? { CODEX_HOME: account.homeDir } : {}),
          ...(provider === "opencode"
            ? {
                XDG_DATA_HOME: join(account.homeDir, "data"),
                XDG_CONFIG_HOME: join(account.homeDir, "config"),
                GH_CONFIG_DIR: join(person.APPDATA, "GitHub CLI"),
              }
            : {}),
        });
      }
    } finally {
      registry.close();
    }
  },
);

test.runIf(windows)(
  "Windows: a session migrates between account homes with its bytes unchanged",
  async () => {
    const request = await homes("claude");
    const project = join(request.from.homeDir, "projects", "C--work-app");
    const files = [
      await put(join(project, `${ids[3]}.jsonl`), '{"type":"user","message":"history"}\n'),
      await put(join(project, ids[3] ?? "", "subagents", "agent-a.jsonl"), "child-history\n"),
    ];
    const before = await Promise.all(files.map(hash));
    expect(await migrateSession(request, idle)).toMatchObject({
      status: "migrated",
      copiedFiles: 2,
    });
    expect(
      await Promise.all(
        files.map((file) => hash(join(request.to.homeDir, relative(request.from.homeDir, file)))),
      ),
    ).toEqual(before);
    const codex = await homes("codex");
    await rollout(codex.from.homeDir, 3);
    expect(await migrateSession(codex, idle)).toMatchObject({ status: "migrated" });
  },
);

test.runIf(windows)(
  "Windows: a junction inside a session's folders is refused, never followed",
  async () => {
    const request = await homes("claude");
    const outside = await temp();
    await put(join(outside, "agent-a.jsonl"), "someone else's file\n");
    await put(join(request.from.homeDir, "projects", "C--work", `${ids[3]}.jsonl`), "history\n");
    const session = join(request.from.homeDir, "projects", "C--work", ids[3] ?? "");
    await mkdir(session, { recursive: true });
    await symlink(outside, join(session, "subagents"), "junction");
    expect(await migrateSession(request, idle)).toMatchObject({ status: "refused" });
  },
);
