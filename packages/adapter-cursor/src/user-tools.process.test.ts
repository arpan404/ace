import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** The person's own environment; the launch env is this plus Cursor's private HOME. */
  userEnv: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(input.instanceHome, "user"), { recursive: true });
  let captured: NodeJS.ProcessEnv | undefined;
  const adapter = createCursorAdapter({
    instance: { id: "tools", homeDir: input.instanceHome },
    userHome: input.userHome,
    userEnv: input.userEnv,
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
        env: { PATH: "/fake", ...input.userEnv, HOME: join(input.instanceHome, "user") },
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

/** What the real git binary reads with the Cursor host's environment, outside any repo. */
function gitConfig(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["config", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.stdout.trim();
}

async function personWithGitConfig(root: string, xdg = join(root, "real", ".config")) {
  const userHome = join(root, "real");
  await mkdir(join(xdg, "git"), { recursive: true });
  await mkdir(userHome, { recursive: true });
  await writeFile(join(userHome, ".gitconfig"), "[user]\n\tname = Person\n");
  await writeFile(join(xdg, "git", "config"), "[credential]\n\thelper = person-helper\n");
  return userHome;
}

it("gh and both of git's global files reach a Cursor session while the SDK keeps its private home", async () => {
  const root = await tempRoot();
  const userHome = await personWithGitConfig(root);
  const instanceHome = join(root, "instance");
  const env = await hostEnv({
    platform: "darwin",
    userHome,
    instanceHome,
    userEnv: { HOME: userHome },
  });
  expect(env).toMatchObject({
    HOME: join(instanceHome, "user"),
    GH_CONFIG_DIR: join(userHome, ".config", "gh"),
  });
  expect(gitConfig(env, root, "--get", "user.name")).toBe("Person");
  expect(gitConfig(env, root, "--get", "credential.helper")).toBe("person-helper");
});

it("on Linux, a person's XDG config root holds the gh config, and git reads its XDG file once", async () => {
  const root = await tempRoot();
  const xdg = join(root, "xdg");
  const userHome = await personWithGitConfig(root, xdg);
  const env = await hostEnv({
    platform: "linux",
    userHome,
    instanceHome: join(root, "instance"),
    userEnv: { HOME: userHome, XDG_CONFIG_HOME: xdg },
  });
  expect(env.GH_CONFIG_DIR).toBe(join(xdg, "gh"));
  expect(gitConfig(env, root, "--get", "user.name")).toBe("Person");
  expect(gitConfig(env, root, "--get-all", "credential.helper")).toBe("person-helper");
});

it("on Windows, a Cursor session uses gh's AppData folder and git's own home, HOME before USERPROFILE", async () => {
  const root = await tempRoot();
  const instanceHome = join(root, "instance");
  const env = await hostEnv({
    platform: "win32",
    userHome: "C:\\Users\\person",
    instanceHome,
    userEnv: {
      HOME: "D:\\GitHome",
      USERPROFILE: "C:\\Users\\person",
      APPDATA: "C:\\Users\\person\\AppData\\Roaming",
    },
  });
  expect(env.GH_CONFIG_DIR).toBe("C:\\Users\\person\\AppData\\Roaming\\GitHub CLI");
  const includes = await readFile(join(instanceHome, "user", ".gitconfig"), "utf8");
  expect(includes).toContain('path = "D:\\\\GitHome\\\\.gitconfig"');
  expect(includes).not.toContain("Users");
});

it("a person's own GH_CONFIG_DIR and GIT_CONFIG_GLOBAL reach a Cursor session unchanged", async () => {
  const root = await tempRoot();
  const userHome = await personWithGitConfig(root);
  const custom = join(root, "custom.gitconfig");
  await writeFile(custom, "[user]\n\tname = Custom\n");
  const env = await hostEnv({
    platform: "darwin",
    userHome,
    instanceHome: join(root, "instance"),
    userEnv: { HOME: userHome, GH_CONFIG_DIR: "/custom/gh", GIT_CONFIG_GLOBAL: custom },
  });
  expect(env.GH_CONFIG_DIR).toBe("/custom/gh");
  expect(gitConfig(env, root, "--get", "user.name")).toBe("Custom");
});

it("on macOS, a Cursor session reaches the person's keychain so gh can read its token", async () => {
  const root = await tempRoot();
  const userHome = join(root, "real");
  const instanceHome = join(root, "instance");
  await mkdir(join(userHome, "Library", "Keychains"), { recursive: true });
  await writeFile(join(userHome, "Library", "Keychains", "login.keychain-db"), "keychain");
  const open = () =>
    hostEnv({ platform: "darwin", userHome, instanceHome, userEnv: { HOME: userHome } });
  await open();
  // A second session open keeps the same link.
  await open();
  const linked = join(instanceHome, "user", "Library", "Keychains", "login.keychain-db");
  expect(await readFile(linked, "utf8")).toBe("keychain");
});

it("on Linux and Windows, a Cursor session's private home gets no keychain link", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = await tempRoot();
    const userHome = join(root, "real");
    const instanceHome = join(root, "instance");
    await mkdir(join(userHome, "Library", "Keychains"), { recursive: true });
    await hostEnv({ platform, userHome, instanceHome, userEnv: { HOME: userHome } });
    await expect(lstat(join(instanceHome, "user", "Library"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});
