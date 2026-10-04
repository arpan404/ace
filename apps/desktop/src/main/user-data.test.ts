import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkUserData, desktopUserData, legacyFolders } from "./user-data.ts";

let user: string;
let appData: string;
let legacy: string[];

beforeEach(async () => {
  user = await mkdtemp(join(tmpdir(), "ace-desktop-data-"));
  appData = join(user, "Library", "Application Support");
  legacy = legacyFolders({ appData, homedir: user });
  // The older ace 0.x app's folders, as found on a real machine.
  await mkdir(join(appData, "ace"), { recursive: true });
  await writeFile(join(appData, "ace", "Cookies"), "legacy");
  await mkdir(join(user, ".ace", "bin"), { recursive: true });
});
afterEach(async () => {
  await rm(user, { recursive: true, force: true });
});

describe("the app's own data folder", () => {
  it("is ace-next, never the 0.x app's folder, whatever daemon the app talks to", () => {
    const chosen = desktopUserData({ explicit: undefined, appData });
    expect(chosen).toBe(join(appData, "ace-next"));
    expect(checkUserData(chosen, legacy)).toBeUndefined();
  });

  it("is ACE_DESKTOP_USER_DATA when set", () => {
    const explicit = join(user, "work", "electron");
    expect(desktopUserData({ explicit, appData })).toBe(explicit);
    expect(checkUserData(explicit, legacy)).toBeUndefined();
  });

  it("is refused when it is a symbolic link, wherever it points", async () => {
    await mkdir(join(user, "elsewhere"));
    await symlink(join(user, "elsewhere"), join(appData, "ace-next"));
    expect(checkUserData(join(appData, "ace-next"), legacy)).toMatch(/symbolic link/);
  });

  it("is refused when a linked ancestor takes it into the 0.x app's folder", async () => {
    await symlink(join(appData, "ace"), join(user, "linked"));
    expect(checkUserData(join(user, "linked", "data"), legacy)).toMatch(/older ace 0\.x app/);
  });

  it("is refused when it names a folder inside the legacy daemon home", () => {
    expect(checkUserData(join(user, ".ace", "electron"), legacy)).toMatch(/older ace 0\.x app/);
    expect(checkUserData(join(appData, "ace"), legacy)).toMatch(/older ace 0\.x app/);
  });

  it("allows a sibling whose name only starts like a legacy folder", () => {
    expect(checkUserData(join(appData, "ace-next"), legacy)).toBeUndefined();
    expect(checkUserData(join(user, ".ace-next-data"), legacy)).toBeUndefined();
  });
});
