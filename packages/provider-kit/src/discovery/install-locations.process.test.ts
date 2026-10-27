import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProvider, findExecutable, findOpenCodeExecutable } from "./index.ts";
import { cleanupDirectories, directory } from "./testing/cli.ts";

afterEach(cleanupDirectories);

type Folders = { home: string; local: string; roaming: string; empty: string };

async function folders(): Promise<Folders> {
  const root = await directory();
  const made = {
    home: join(root, "home"),
    local: join(root, "home", "AppData", "Local"),
    roaming: join(root, "home", "AppData", "Roaming"),
    empty: join(root, "empty"),
  };
  await Promise.all(Object.values(made).map((path) => mkdir(path, { recursive: true })));
  return made;
}

/** The key the daemon's own environment uses for a variable (`Path`, `USERPROFILE`, ...). */
function key(name: string): string {
  return Object.keys(process.env).find((each) => each.toUpperCase() === name) ?? name;
}

/** The daemon's own environment with PATH and the per-user folders replaced by the test's. */
function environment(dirs: Folders, path: string): NodeJS.ProcessEnv {
  const replaced = new Set(["PATH", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SCOOP"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (!replaced.has(name.toUpperCase())) env[name] = value;
  return {
    ...env,
    [key("PATH")]: path,
    [key("USERPROFILE")]: dirs.home,
    [key("LOCALAPPDATA")]: dirs.local,
    [key("APPDATA")]: dirs.roaming,
  };
}

async function place(path: string, content = "stand-in"): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

/** A runnable `.cmd` shim, as npm writes them, around a Node script printing fixed output. */
async function cliShim(path: string, version: string, auth = ""): Promise<string> {
  const script = `${path}.cjs`;
  await place(
    script,
    `process.stdout.write(process.argv[2] === "--version" ? ${JSON.stringify(version)} : ${JSON.stringify(auth)});\n`,
  );
  return place(`${path}.cmd`, `@"${process.execPath}" "${script}" %*\r\n`);
}

describe.runIf(process.platform === "win32")("Windows installer folders", () => {
  const layouts: [string, (dirs: Folders) => string][] = [
    ["claude", (d) => join(d.home, ".local", "bin", "claude.exe")],
    ["codex", (d) => join(d.local, "Programs", "OpenAI", "Codex", "bin", "codex.exe")],
    ["cursor-agent", (d) => join(d.local, "cursor-agent", "cursor-agent.cmd")],
    ["uv", (d) => join(d.home, ".local", "bin", "uv.exe")],
    ["pi", (d) => join(d.roaming, "npm", "pi.cmd")],
    ["codex", (d) => join(d.home, ".bun", "bin", "codex.exe")],
    ["gemini", (d) => join(d.local, "Microsoft", "WinGet", "Links", "gemini.exe")],
    ["agy_acp_server", (d) => join(d.home, "scoop", "shims", "agy_acp_server.exe")],
  ];

  it.each(layouts)(
    "%s is found where its installer puts it when PATH lacks it",
    async (command, at) => {
      const dirs = await folders();
      const expected = await place(at(dirs));
      expect(await findExecutable(command, environment(dirs, dirs.empty))).toBe(expected);
    },
  );

  it("installer folders are read without regard to environment key case", async () => {
    const dirs = await folders();
    const expected = await place(
      join(dirs.local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    );
    const env = { pAtH: dirs.empty, LocalAppData: dirs.local };
    expect(await findExecutable("codex", env)).toBe(expected);
  });

  it("a Scoop install under a custom SCOOP root is found", async () => {
    const dirs = await folders();
    const scoop = join(dirs.home, "tools", "scoop");
    const expected = await place(join(scoop, "shims", "gemini.cmd"));
    expect(await findExecutable("gemini", { ...environment(dirs, dirs.empty), SCOOP: scoop })).toBe(
      expected,
    );
  });

  it("PATH still wins over an installer folder", async () => {
    const dirs = await folders();
    await place(join(dirs.home, ".local", "bin", "claude.exe"));
    const onPath = await place(join(dirs.empty, "claude.cmd"));
    expect(await findExecutable("claude", environment(dirs, dirs.empty))).toBe(onPath);
  });

  it("a vendor installer folder wins over a package-manager shim", async () => {
    const dirs = await folders();
    await place(join(dirs.roaming, "npm", "claude.cmd"));
    const native = await place(join(dirs.home, ".local", "bin", "claude.exe"));
    expect(await findExecutable("claude", environment(dirs, dirs.empty))).toBe(native);
  });

  it("commands that are not agent CLIs never search installer folders", async () => {
    const dirs = await folders();
    await place(join(dirs.roaming, "npm", "git.cmd"));
    await place(join(dirs.home, ".local", "bin", "ffmpeg.exe"));
    const env = environment(dirs, dirs.empty);
    expect(await findExecutable("git", env)).toBeUndefined();
    expect(await findExecutable("ffmpeg", env)).toBeUndefined();
  });

  it("an extensionless npm sh shim beside the .cmd is never chosen", async () => {
    const dirs = await folders();
    await place(join(dirs.roaming, "npm", "pi"));
    const expected = await place(join(dirs.roaming, "npm", "pi.cmd"));
    expect(await findExecutable("pi", environment(dirs, dirs.empty))).toBe(expected);
  });

  it("Claude installed by npm outside PATH is discovered and probed through its .cmd shim", async () => {
    const dirs = await folders();
    const shim = await cliShim(
      join(dirs.roaming, "npm", "claude"),
      "2.1.286 (Claude Code)",
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    );
    const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    const result = await discoverProvider("claude", {
      env: environment(dirs, `${dirs.empty};${system}`),
    });
    expect(result).toMatchObject({
      installed: true,
      path: shim,
      version: "2.1.286",
      auth: "logged_in",
    });
    expect(result.error).toBeUndefined();
  });

  it("an explicit PATH given over the daemon's inherited Path is the one searched and launched", async () => {
    const dirs = await folders();
    const shim = await cliShim(
      join(dirs.empty, "claude"),
      "2.1.286 (Claude Code)",
      JSON.stringify({ loggedIn: false }),
    );
    const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    // Merged over process.env, whose own spelling is usually `Path`: a spawned child sees the
    // first of the sorted spellings, `PATH`, so the lookup must search that one too.
    const result = await discoverProvider("claude", { env: { PATH: `${dirs.empty};${system}` } });
    expect(result).toMatchObject({ installed: true, path: shim, version: "2.1.286" });
  });

  it("OpenCode v2 in its installer folder is chosen over a v1 earlier on a mixed-case Path", async () => {
    const dirs = await folders();
    const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    await cliShim(join(dirs.empty, "opencode"), "1.4.0");
    const v2 = await cliShim(join(dirs.home, ".opencode", "bin", "opencode"), "2.0.22");
    const found = await findOpenCodeExecutable("opencode", {
      env: environment(dirs, `${dirs.empty};${system}`),
    });
    expect(found).toEqual({ path: v2, version: "2.0.22" });
  });
});
