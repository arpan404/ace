import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";
import { discoverProviders, findExecutable, versionManagerShim } from "@ace/provider-kit/discovery";
import { forbiddenTools, prepareTestToolPath } from "./test-tool-path.ts";
import { planWindowsToolPath } from "./test-tool-path-windows.ts";

const posix = process.platform !== "win32";

async function tool(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

test.runIf(posix)(
  "a test PATH reaches runtimes and system tools but no agent CLI or version-manager shim",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-tool-path-")));
    // A mise setup: shims and command wrappers link to the mise binary, which installs on use.
    const mise = await tool(join(root, "mise-bin"), "mise");
    const shims = join(root, "home/.local/share/mise/shims");
    const wrappers = join(root, "home/.local/share/mise/command-wrappers/bin");
    await mkdir(shims, { recursive: true });
    await mkdir(wrappers, { recursive: true });
    for (const name of ["claude", "node", "cargo"]) await symlink(mise, join(shims, name));
    await symlink(mise, join(wrappers, "codex"));
    // A Node install's bin holds global npm installs (an agent CLI) beside node itself.
    const nodeBin = join(root, "home/.local/share/mise/installs/node/26/bin");
    const node = await tool(nodeBin, "node");
    await tool(nodeBin, "opencode");
    const homeBin = join(root, "home/.local/bin");
    await tool(homeBin, "pi");
    const cargo = await tool(join(root, "home/.cargo/bin"), "cargo");
    // A system directory with a packaged agent CLI and a stray shim.
    const system = join(root, "usr/bin");
    const git = await tool(system, "git");
    await tool(system, "claude");
    await symlink(mise, join(system, "bun"));
    const bun = await tool(join(root, "runtime"), "bun");

    const PATH = await prepareTestToolPath(
      join(root, "tools"),
      {
        PATH: [wrappers, nodeBin, homeBin, system, join(root, "home/.cargo/bin"), shims].join(
          delimiter,
        ),
      },
      bun,
      [system],
    );

    const resolve = async (name: string) => {
      const found = await findExecutable(name, { PATH });
      return found && (await realpath(found));
    };
    expect(await resolve("node")).toBe(node);
    expect(await resolve("cargo")).toBe(cargo);
    expect(await resolve("git")).toBe(git);
    expect(await resolve("bun")).toBe(bun);
    for (const name of ["claude", "codex", "opencode", "pi", "mise"])
      expect(await resolve(name)).toBeUndefined();
    for (const name of await readdir(PATH)) expect(await realpath(join(PATH, name))).not.toBe(mise);
  },
);

test("every process a test starts finds no agent CLI and no version-manager shim on its PATH", async () => {
  // The setup file gave this worker the environment every test daemon and fixture inherits.
  const env = process.env;
  for (const name of forbiddenTools) expect(await findExecutable(name, env), name).toBeUndefined();
  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const names = await readdir(entry).catch(() => []);
    for (const name of names) {
      const path = join(entry, name);
      const target = await realpath(path).catch(() => path);
      expect(versionManagerShim(path, target), path).toBeUndefined();
    }
  }
  // What a daemon under test sees when it probes for the agent CLIs.
  const providers = await discoverProviders({ env, timeoutMs: 5_000 });
  for (const [provider, result] of Object.entries(providers))
    expect(result.installed, provider).toBe(false);
  if (posix) expect(await findExecutable("git", env)).toBeDefined();
});

test("on Windows a test PATH keeps clean folders, and only the allowed tools of a folder holding an agent CLI", () => {
  const plan = planWindowsToolPath(
    [
      { directory: "C:\\Windows\\System32", names: ["cmd.exe", "where.exe", "kernel32.dll"] },
      // npm's global bin: agent CLIs beside tools tests need.
      {
        directory: "C:\\Users\\p\\AppData\\Roaming\\npm",
        names: ["codex.cmd", "codex.ps1", "claude.cmd", "pnpm.cmd", "tsc.cmd"],
      },
      { directory: "C:\\Users\\p\\.local\\share\\mise\\shims", names: ["node.exe", "bun.exe"] },
      { directory: "C:\\Program Files\\Git\\cmd", names: ["git.exe"] },
      { directory: "C:\\Users\\p\\.bun\\bin", names: ["bun.exe", "bunx.exe", "opencode.exe"] },
      // Shadowed by System32's where.exe, as on the person's PATH.
      { directory: "C:\\Tools", names: ["Claude.EXE", "where.exe"] },
    ],
    [".COM", ".EXE", ".BAT", ".CMD"],
    "C:\\Program Files\\nodejs\\node.exe",
  );
  expect(plan.keep).toEqual(["C:\\Windows\\System32", "C:\\Program Files\\Git\\cmd"]);
  expect(plan.tools).toEqual([
    { name: "node.exe", target: "C:\\Program Files\\nodejs\\node.exe", kind: "copy" },
    { name: "pnpm.cmd", target: "C:\\Users\\p\\AppData\\Roaming\\npm\\pnpm.cmd", kind: "wrapper" },
    { name: "tsc.cmd", target: "C:\\Users\\p\\AppData\\Roaming\\npm\\tsc.cmd", kind: "wrapper" },
    { name: "bun.exe", target: "C:\\Users\\p\\.bun\\bin\\bun.exe", kind: "copy" },
    { name: "bunx.exe", target: "C:\\Users\\p\\.bun\\bin\\bunx.exe", kind: "copy" },
  ]);
});
