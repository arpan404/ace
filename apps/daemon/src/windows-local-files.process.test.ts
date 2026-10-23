import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type TestContext } from "vitest";
import { prepareDaemonHome } from "@ace/service/home";
import { PinnedDirectory } from "@ace/workspace";
import { loadHostId, loadToken, secureDataDir } from "./local-files.ts";

const win = test.runIf(process.platform === "win32");

win(
  "Windows data directory creation stays private and refuses an existing inherited directory",
  async ({ onTestFinished }) => {
    const home = await fixture(onTestFinished);
    const privatePath = join(home, "mcp-enrollments");
    secureDataDir(privatePath);
    secureDataDir(privatePath);
    const directory = PinnedDirectory.atBoundary(privatePath);
    try {
      directory.checkPrivate();
    } finally {
      directory.closeSync();
    }
    const inherited = join(home, "inherited");
    await mkdir(inherited);
    expect(() => secureDataDir(inherited)).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(await readdir(inherited)).toEqual([]);
  },
);

async function fixture(onTestFinished: TestContext["onTestFinished"]) {
  const base = await mkdtemp(join(tmpdir(), "ace-windows-local-files-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  prepareDaemonHome(home);
  return home;
}

win(
  "Windows daemon identity files stay private and retain their values across reloads",
  async ({ onTestFinished }) => {
    const home = await fixture(onTestFinished);
    secureDataDir(home);
    const token = loadToken(home);
    const host = loadHostId(home);
    expect(token.token).toMatch(/^[0-9a-f]{64}$/);
    expect(host).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadToken(home)).toEqual(token);
    expect(loadHostId(home)).toBe(host);
    const directory = PinnedDirectory.atBoundary(home);
    try {
      expect(directory.readPrivateText("daemon-token", 64)).toBe(token.token);
      expect(directory.readPrivateText("host-id", 128)).toBe(host);
    } finally {
      directory.closeSync();
    }
  },
);

win(
  "Windows identity loaders refuse inherited files without repairing their permissions",
  async ({ onTestFinished }) => {
    const home = await fixture(onTestFinished);
    // Ordinary writes inherit a DACL, rather than installing the protected
    // current-user descriptor required by the private-file contract.
    const token = "a".repeat(64);
    await writeFile(join(home, "daemon-token"), token);
    await writeFile(join(home, "host-id"), "existing identity");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => loadToken(home)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(() => loadHostId(home)).toThrow(expect.objectContaining({ code: "EACCES" }));
    }
    expect(await readFile(join(home, "daemon-token"), "utf8")).toBe(token);
    expect(await readFile(join(home, "host-id"), "utf8")).toBe("existing identity");
  },
);

win(
  "Windows daemon token loading refuses a hardlinked private file",
  async ({ onTestFinished }) => {
    const home = await fixture(onTestFinished);
    const token = loadToken(home).token;
    await link(join(home, "daemon-token"), join(home, "alias"));
    expect(() => loadToken(home)).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(await readFile(join(home, "alias"), "utf8")).toBe(token);
  },
);
