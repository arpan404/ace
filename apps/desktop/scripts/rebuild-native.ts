#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { rebuild } from "@electron/rebuild";
import { electronVersion, repo } from "./common.ts";

/**
 * `bun run desktop:rebuild-native`: compiles node-pty against Electron's headers with
 * @electron/rebuild. node-pty 1.x is a Node-API addon, so its npm prebuilds already load in
 * Electron's Node on macOS and Windows; this is needed on Linux (no prebuilds) and whenever
 * a prebuild is missing or a native dependency stops using Node-API. The desktop build
 * prefers the rebuilt `build/Release/pty.node`.
 */
const terminal = join(repo, "packages/terminal");
const modulePath = dirname(createRequire(join(terminal, "package.json")).resolve("node-pty/package.json"));
await rebuild({
  buildPath: terminal,
  electronVersion: electronVersion(),
  onlyModules: ["node-pty"],
  force: true,
});
console.log(`[rebuild-native] node-pty rebuilt for Electron ${electronVersion()} in ${modulePath}`);
