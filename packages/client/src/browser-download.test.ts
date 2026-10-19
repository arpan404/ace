import { expect, it } from "vitest";
import { downloadBusy, type StreamMessage } from "@ace/browser/stream";
import { ThreadId } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { fetchBrowserDownload } from "./browser-download.ts";
import { ClientError } from "./errors.ts";

const file = Uint8Array.from({ length: 600 * 1024 }, (_, index) => (index * 5) % 241);

/**
 * A connection to a daemon serving `file` as downloads `download-1`: its replies and chunk
 * stream messages, with a script of what goes wrong on each read (by call number).
 */
function connection(trouble: Record<number, "busy" | "lost" | "offline">) {
  const listeners = new Set<(message: StreamMessage) => void>();
  const offsets: number[] = [];
  let calls = 0;
  const client = {
    onStream(listener: (message: StreamMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(query: { offset: number; length: number }) {
      calls++;
      offsets.push(query.offset);
      const problem = trouble[calls];
      if (problem === "offline") throw new ClientError("offline");
      if (problem === "busy") return { ok: false, error: downloadBusy };
      const bytes = file.subarray(query.offset, query.offset + query.length);
      if (problem !== "lost")
        for (const listener of listeners)
          listener({
            kind: "browser.download.chunk",
            threadId: ThreadId.parse("thread-1"),
            downloadId: "download-1",
            offset: query.offset,
            size: file.length,
            bytes,
          });
      return {
        ok: true,
        result: {
          downloadId: "download-1",
          offset: query.offset,
          bytes: bytes.length,
          size: file.length,
          validator: "v1",
          done: query.offset + bytes.length === file.length,
        },
      };
    },
  } as unknown as Pick<ClientApi, "request" | "onStream">;
  return { client, offsets };
}

const fetch = (client: Pick<ClientApi, "request" | "onStream">) =>
  fetchBrowserDownload(client, "thread-1", "download-1", { wait: async () => {} });

it("a download arrives whole through a dropped connection, a busy daemon and a lost chunk", async () => {
  const { client, offsets } = connection({ 2: "offline", 3: "busy", 4: "lost" });
  expect(await fetch(client)).toEqual(file);
  // Every retry asks for the same place again; nothing already received is fetched twice.
  expect(offsets).toEqual([0, 262_144, 262_144, 262_144, 262_144, 524_288]);
});

it("a daemon refusal other than busy ends the save", async () => {
  const { client } = connection({});
  const refusing = {
    ...client,
    request: async () => ({ ok: false, error: "No finished download with that id in this thread" }),
  } as unknown as Pick<ClientApi, "request" | "onStream">;
  await expect(fetch(refusing)).rejects.toThrow(/No finished download/);
});
