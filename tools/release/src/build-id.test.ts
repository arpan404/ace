import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assembleRelease, buildIdFile, releaseDigest, writeBuildId } from "./build-id.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** A daemon release root as the bundle step lays it out, with fixed-name helpers and assets. */
function release(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-build-id-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "ace.mjs"), 'import "./chunk-AAAA.mjs";');
  writeFileSync(join(root, "chunk-AAAA.mjs"), "export const decode = 1;");
  writeFileSync(join(root, "history-publish-worker.mjs"), "export const store = 1;");
  writeFileSync(join(root, "markit_wasm_bg.wasm"), Buffer.from([0, 97, 115, 109]));
  mkdirSync(join(root, "node_modules/native"), { recursive: true });
  writeFileSync(join(root, "node_modules/native/addon.node"), Buffer.from([1, 2, 3]));
  return root;
}
function copy(root: string): string {
  const other = mkdtempSync(join(tmpdir(), "ace-build-id-"));
  cleanup.push(() => rmSync(other, { recursive: true, force: true }));
  cpSync(root, other, { recursive: true });
  return other;
}

it("changing only a fixed-name helper bundle changes the build id", async () => {
  const root = release();
  const patched = copy(root);
  writeFileSync(join(patched, "history-publish-worker.mjs"), "export const store = 2;");
  expect(await releaseDigest(patched)).not.toBe(await releaseDigest(root));
});

it("changing only a native or wasm asset changes the build id", async () => {
  const root = release();
  const native = copy(root);
  writeFileSync(join(native, "node_modules/native/addon.node"), Buffer.from([1, 2, 4]));
  const wasm = copy(root);
  writeFileSync(join(wasm, "markit_wasm_bg.wasm"), Buffer.from([0, 97, 115, 110]));
  const id = await releaseDigest(root);
  expect(await releaseDigest(native)).not.toBe(id);
  expect(await releaseDigest(wasm)).not.toBe(id);
});

it("an identical rebuild keeps the build id, whether or not one was written", async () => {
  const root = release();
  const rebuilt = copy(root);
  const written = await writeBuildId(root);
  expect(readFileSync(join(root, buildIdFile), "utf8")).toBe(`${written}\n`);
  expect(await releaseDigest(rebuilt)).toBe(written);
  expect(await writeBuildId(root)).toBe(written);
});

it("moving a file to another name changes the build id", async () => {
  const root = release();
  const renamed = copy(root);
  rmSync(join(renamed, "chunk-AAAA.mjs"));
  writeFileSync(join(renamed, "chunk-BBBB.mjs"), "export const decode = 1;");
  expect(await releaseDigest(renamed)).not.toBe(await releaseDigest(root));
});

it("a file staged after the bundle still changes the assembled release's build id", async () => {
  /** An assembly like the release build's: the bundle first, then a server staged after it. */
  const assemble = (server: string) => {
    const root = mkdtempSync(join(tmpdir(), "ace-build-id-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    return assembleRelease(root, [
      async () => writeFileSync(join(root, "ace.mjs"), 'import "./chunk-AAAA.mjs";'),
      async () => {
        mkdirSync(join(root, "spade"));
        writeFileSync(join(root, "spade/spade-server"), server);
      },
    ]).then((id) => ({ root, id }));
  };
  const first = await assemble("server 1");
  const rebuilt = await assemble("server 1");
  const patched = await assemble("server 2");
  expect(rebuilt.id).toBe(first.id);
  expect(patched.id).not.toBe(first.id);
  expect(readFileSync(join(patched.root, buildIdFile), "utf8")).toBe(`${patched.id}\n`);
});
