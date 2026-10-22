import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createCursorAdapter } from "./index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// A supported SDK installation, resolved without touching the real one.
const discovery = {
  resolve: (id: string) =>
    id === "@cursor/sdk" ? "/sdk/dist/esm/index.js" : "/helper/package.json",
  read: async (path: string) =>
    path === "/sdk/package.json"
      ? '{"name":"@cursor/sdk","version":"1.0.35"}'
      : path === "/helper/package.json"
        ? '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}'
        : Promise.reject(new Error("missing")),
  executable: async () => {},
  platform: "darwin" as const,
  arch: "arm64",
  nodeVersion: "24.0.0",
};

/** Open a Cursor session and return the environment its SDK host would start with. */
async function hostEnv(input: {
  platform: NodeJS.Platform;
  userHome: string;
  instanceHome: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(input.instanceHome, "user"), { recursive: true });
  let captured: NodeJS.ProcessEnv | undefined;
  const adapter = createCursorAdapter({
    instance: { id: "tools", homeDir: input.instanceHome },
    userHome: input.userHome,
    platform: input.platform,
    discovery,
    spawn: (options) => {
      captured = options.env;
      throw new Error("stop at host start");
    },
  });
  try {
    await expect(
      adapter.openSession({
        threadId: ThreadId.parse("cursor-tools"),
        cwd: input.instanceHome,
        env: { PATH: "/fake", ...input.env, HOME: join(input.instanceHome, "user") },
        signal: new AbortController().signal,
        onFrame: () => {},
        onExit: () => {},
      }),
    ).rejects.toThrow();
  } finally {
    await adapter.close();
  }
  if (!captured) throw new Error("SDK host never started");
  return captured;
}

async function tempRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-tools-")));
  roots.push(root);
  return root;
}

it("gh and git inside a Cursor session read the person's real config while the SDK keeps its private home", async () => {
  const root = await tempRoot();
  const userHome = join(root, "real");
  const instanceHome = join(root, "instance");
  await mkdir(userHome, { recursive: true });
  await writeFile(join(userHome, ".gitconfig"), "[user]\n\tname = Person\n");
  const env = await hostEnv({ platform: "darwin", userHome, instanceHome });
  expect(env).toMatchObject({
    HOME: join(instanceHome, "user"),
    GH_CONFIG_DIR: join(userHome, ".config", "gh"),
    GIT_CONFIG_GLOBAL: join(userHome, ".gitconfig"),
  });
});

it("on Linux, a person's XDG config root holds the gh and git config a Cursor session uses", async () => {
  const root = await tempRoot();
  const userHome = join(root, "real");
  const xdg = join(root, "xdg");
  await mkdir(join(xdg, "git"), { recursive: true });
  await writeFile(join(xdg, "git", "config"), "[user]\n\tname = Person\n");
  const env = await hostEnv({
    platform: "linux",
    userHome,
    instanceHome: join(root, "instance"),
    env: { XDG_CONFIG_HOME: xdg },
  });
  expect(env).toMatchObject({
    GH_CONFIG_DIR: join(xdg, "gh"),
    GIT_CONFIG_GLOBAL: join(xdg, "git", "config"),
  });
});

it("on Windows, a Cursor session uses gh's AppData folder and the profile's .gitconfig", async () => {
  const root = await tempRoot();
  const userHome = "C:\\Users\\person";
  const env = await hostEnv({
    platform: "win32",
    userHome,
    instanceHome: join(root, "instance"),
    env: { APPDATA: "C:\\Users\\person\\AppData\\Roaming" },
  });
  expect(env).toMatchObject({
    GH_CONFIG_DIR: "C:\\Users\\person\\AppData\\Roaming\\GitHub CLI",
    GIT_CONFIG_GLOBAL: win32.join(userHome, ".gitconfig"),
  });
});

it("a person's own GH_CONFIG_DIR and GIT_CONFIG_GLOBAL reach a Cursor session unchanged", async () => {
  const root = await tempRoot();
  const env = await hostEnv({
    platform: "darwin",
    userHome: join(root, "real"),
    instanceHome: join(root, "instance"),
    env: { GH_CONFIG_DIR: "/custom/gh", GIT_CONFIG_GLOBAL: "/custom/gitconfig" },
  });
  expect(env).toMatchObject({
    GH_CONFIG_DIR: "/custom/gh",
    GIT_CONFIG_GLOBAL: "/custom/gitconfig",
  });
});

it("on macOS, a Cursor session reaches the person's keychain so gh can read its token", async () => {
  const root = await tempRoot();
  const userHome = join(root, "real");
  const instanceHome = join(root, "instance");
  await mkdir(join(userHome, "Library", "Keychains"), { recursive: true });
  await writeFile(join(userHome, "Library", "Keychains", "login.keychain-db"), "keychain");
  await hostEnv({ platform: "darwin", userHome, instanceHome });
  // Twice: a second session open keeps the same link.
  await hostEnv({ platform: "darwin", userHome, instanceHome });
  const linked = join(instanceHome, "user", "Library", "Keychains", "login.keychain-db");
  expect(await readFile(linked, "utf8")).toBe("keychain");
});

it("on Linux and Windows, a Cursor session's private home gets no keychain link", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = await tempRoot();
    const userHome = join(root, "real");
    const instanceHome = join(root, "instance");
    await mkdir(join(userHome, "Library", "Keychains"), { recursive: true });
    await hostEnv({ platform, userHome, instanceHome });
    await expect(lstat(join(instanceHome, "user", "Library"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});
