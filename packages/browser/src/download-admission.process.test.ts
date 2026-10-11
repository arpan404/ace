import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished, vi } from "vitest";
import { BrowserOpen } from "@ace/protocol";
import { HeadlessDownloads } from "./headless-downloads.ts";

it("six approved downloads finish while only four streams transfer at once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-download-admission-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const streams: Readable[] = [];
  const cancelled: number[] = [];
  const artifacts: string[] = [];
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
    artifact(artifact) {
      artifacts.push(artifact.path);
    },
  });
  const tasks = Array.from({ length: 6 }, (_, index) =>
    downloads.accept(
      {
        suggestedFilename: () => `${index}.txt`,
        url: () => `http://localhost/${index}.txt`,
        async cancel() {
          cancelled.push(index);
        },
        async delete() {},
        async createReadStream() {
          const stream = new Readable({ read() {} });
          streams.push(stream);
          return stream;
        },
      },
      "tab",
    ),
  );
  onTestFinished(async () => {
    for (const stream of streams) stream.push(null);
    await Promise.all(tasks);
  });
  await vi.waitFor(() => expect(streams).toHaveLength(4), { timeout: 1000 });
  for (const stream of streams.slice()) {
    stream.push("first");
    stream.push(null);
  }
  await vi.waitFor(() => expect(streams).toHaveLength(6), { timeout: 1000 });
  for (const stream of streams.slice(4)) {
    stream.push("queued");
    stream.push(null);
  }
  await Promise.all(tasks);
  expect(cancelled).toEqual([]);
  expect(downloads.list().map((entry) => entry.state)).toEqual(Array(6).fill("complete"));
  expect((await Promise.all(artifacts.map((path) => readFile(path, "utf8")))).toSorted()).toEqual([
    "first",
    "first",
    "first",
    "first",
    "queued",
    "queued",
  ]);
});
