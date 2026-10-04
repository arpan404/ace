import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { electronDist } from "./electron-dist.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An app whose `electron` package runs `index` when required, like Electron 40+. */
async function appWithElectron(index: string): Promise<{ packageJson: string; electron: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-electron-dist-")));
  roots.push(root);
  const electron = join(root, "node_modules/electron");
  await mkdir(electron, { recursive: true });
  await writeFile(
    join(electron, "package.json"),
    JSON.stringify({ name: "electron", version: "44.0.0", main: "index.js" }),
  );
  await writeFile(join(electron, "index.js"), index);
  const packageJson = join(root, "package.json");
  await writeFile(packageJson, JSON.stringify({ name: "app" }));
  return { packageJson, electron };
}

describe("electronDist", () => {
  it("fetches Electron's build when a fresh install has not downloaded it yet", async () => {
    // Electron 40+ downloads on first require; this stand-in "downloads" by creating dist/.
    const { packageJson, electron } = await appWithElectron(`
      const fs = require("node:fs");
      const path = require("node:path");
      const binary = path.join(__dirname, "dist", "electron");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "");
      module.exports = binary;
    `);
    expect(existsSync(join(electron, "dist"))).toBe(false);

    const dist = electronDist(packageJson);

    expect(dist).toBe(join(electron, "dist"));
    expect(existsSync(join(dist, "electron"))).toBe(true);
  });

  it("fails when the electron package still has no build after it is required", async () => {
    const { packageJson } = await appWithElectron(
      `module.exports = require("node:path").join(__dirname, "dist", "electron");`,
    );

    expect(() => electronDist(packageJson)).toThrow(/no downloaded build/);
  });
});
