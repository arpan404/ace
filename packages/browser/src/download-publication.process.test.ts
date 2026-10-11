import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { BrowserOpen } from "@ace/protocol";
import { HeadlessDownloads } from "./headless-downloads.ts";

it("failed artifact publication leaves no completed download or deleted path and the next transfer succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-download-publication-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  let rejectPublication = true;
  const published: string[] = [];
  const downloads = new HeadlessDownloads({
    options: BrowserOpen.parse({ threadId: "thread", workspaceId: "workspace" }),
    profileDir: directory,
    downloadDir: directory,
    signal: new AbortController().signal,
    allowed: async () => true,
    downloadAllowed: async () => true,
    navigation() {},
    log() {},
    lost() {},
    async artifact(artifact) {
      expect(await readFile(artifact.path, "utf8")).toBe("downloaded bytes");
      // Publication is still pending until its durable sink acknowledges it.
      expect(downloads.list().at(-1)).toMatchObject({ state: "pending" });
      if (rejectPublication) throw new Error("Artifact store unavailable");
      published.push(artifact.path);
    },
  });
  const download = {
    suggestedFilename: () => "report.txt",
    url: () => "http://localhost/report.txt",
    async cancel() {},
    async delete() {},
    async createReadStream() {
      return Readable.from(["downloaded bytes"]);
    },
  };
  await downloads.accept(download, "tab");
  expect(downloads.list()).toMatchObject([{ state: "failed", bytes: 16 }]);
  expect(downloads.list()[0]).not.toHaveProperty("path");
  expect(await readdir(directory)).toEqual([]);
  expect(published).toEqual([]);
  rejectPublication = false;
  await downloads.accept(download, "tab");
  expect(downloads.list()).toMatchObject([
    { state: "failed" },
    { state: "complete", path: published[0] },
  ]);
  expect(published).toHaveLength(1);
  expect(await readFile(published[0] ?? "", "utf8")).toBe("downloaded bytes");
});
