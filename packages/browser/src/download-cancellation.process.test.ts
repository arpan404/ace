import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { BrowserOpen } from "@ace/protocol";
import { HeadlessDownloads } from "./headless-downloads.ts";

it.each(["private", "unconfigured"])(
  "a %s download still deletes its temporary bytes when cancellation rejects",
  async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "ace-download-cancel-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "temporary");
    await writeFile(path, "temporary bytes");
    const downloads = new HeadlessDownloads({
      options: BrowserOpen.parse({ threadId: "thread", workspaceId: "workspace" }),
      profileDir: directory,
      ...(reason === "private" ? { downloadDir: directory } : {}),
      signal: new AbortController().signal,
      allowed: async () => true,
      navigation() {},
      log() {},
      lost() {},
    });
    downloads.privacy(reason === "private");
    await expect(
      downloads.accept(
        {
          suggestedFilename: () => "file.txt",
          url: () => "http://localhost/file.txt",
          async cancel() {
            throw new Error("Browser transport lost");
          },
          async delete() {
            await rm(path);
          },
          async createReadStream() {
            throw new Error("A denied download must not transfer");
          },
        },
        "tab",
      ),
    ).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    expect(downloads.list()).toEqual([]);
  },
);

it("a privately denied native download survives a failed cancel and removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-native-download-cancel-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const guid = "native-11111111-1111-1111-1111-111111111111";
  await writeFile(join(directory, guid), "private bytes");
  const script = `
    import assert from 'node:assert/strict';
    import { readdir } from 'node:fs/promises';
    import { EmbeddedDownloads } from ${JSON.stringify(new URL("./embedded-downloads.ts", import.meta.url).href)};
    const directory = process.argv[1];
    const downloads = new EmbeddedDownloads({
      options: {threadId: 'thread', workspaceId: 'workspace'},
      profileDir: directory, downloadDir: directory,
      signal: new AbortController().signal,
      allowed: async () => true, navigation() {}, log() {}, lost() {},
      artifact() { throw new Error('Private download published'); },
    }, {send: async () => { throw new Error('Desktop transport backpressure'); }, on() {}, off() {}});
    downloads.transfers.privacy(true);
    downloads.handle('tab', 'ace.download.started', {
      guid: ${JSON.stringify(guid)}, url: 'http://localhost/file.txt', filename: 'file.txt', mimeType: 'text/plain',
    });
    await new Promise(resolve => process.once('beforeExit', resolve));
    downloads.stop();
    assert.deepEqual(downloads.transfers.list(), []);
    assert.deepEqual(await readdir(directory), []);
    console.log('native cancellation settled');
  `;
  const child = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", script, directory],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      timeout: 10_000,
    },
  );
  expect(child.stdout.trim()).toBe("native cancellation settled");
  expect(await readdir(directory)).toEqual([]);
});
