import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { BrowserOpen } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";
import { EmbeddedDownloads } from "./embedded-downloads.ts";

const temp = async (name: string) => {
  const path = await mkdtemp(join(tmpdir(), name));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
};

/** A desktop download the daemon lets through: the desktop's bytes, then "completed". */
async function nativeDownload(folder: string | undefined) {
  const staging = await temp("ace-native-staging-");
  const guid = `native-${randomUUID()}`;
  await writeFile(join(staging, guid), "native-bytes");
  let downloads: EmbeddedDownloads | undefined;
  const cdp: BrowserCdp = {
    async send(_method, params) {
      if (params?.method === "ace.download.resume")
        setImmediate(() =>
          downloads?.handle("tab", "ace.download.progress", {
            guid,
            bytes: 12,
            state: "completed",
          }),
        );
      return {};
    },
    on() {},
    off() {},
  };
  downloads = new EmbeddedDownloads(
    {
      options: BrowserOpen.parse({ threadId: "thread", workspaceId: "workspace" }),
      profileDir: staging,
      downloadDir: staging,
      signal: new AbortController().signal,
      allowed: async () => true,
      downloadAllowed: async () => true,
      navigation() {},
      log() {},
      lost() {},
    },
    cdp,
  );
  downloads.handle("tab", "ace.download.started", {
    guid,
    url: "http://localhost/notes.txt",
    filename: "notes.txt",
    mimeType: "text/plain",
    ...(folder ? { folder } : {}),
  });
  await vi.waitFor(() => expect(downloads.transfers.list()[0]?.state).toBe("complete"));
  return { staging, entry: downloads.transfers.list()[0] };
}

it("the desktop's chosen folder receives a native download, listed at its real path", async () => {
  const chosen = await temp("ace-desktop-downloads-");
  const { entry } = await nativeDownload(chosen);
  expect(entry?.path).toBe(join(chosen, "notes.txt"));
  expect(await readFile(join(chosen, "notes.txt"), "utf8")).toBe("native-bytes");
});

it("without a folder from the desktop, a native download stays with the thread", async () => {
  const { staging, entry } = await nativeDownload(undefined);
  expect(entry?.path?.startsWith(staging)).toBe(true);
  expect(await readdir(staging)).toEqual([entry?.path?.slice(staging.length + 1)]);
});
