import type { ClientApi } from "@ace/client";
import { expect, it } from "vitest";
import { readsAsText, readTextPrefixIfText } from "./attachment-content.ts";

const decoded = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes));

it("source and prose with tabs and newlines read as text", () => {
  expect(readsAsText("module example.com/x\n\ngo 1.24\n\trequire (\r\n)")).toBe(true);
  expect(readsAsText("Größe · 大小 · emoji 🎉")).toBe(true);
});

it("bytes with NULs or invalid UTF-8 read as binary", () => {
  expect(readsAsText(decoded([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]))).toBe(false);
  expect(readsAsText(decoded([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]))).toBe(false);
});

/** A daemon streaming one linked file in 4 KB chunks, counting downloads and chunks sent. */
function streaming(bytes: Uint8Array) {
  const seen = { downloads: 0, chunks: 0 };
  const client = {
    async *downloadFile() {
      seen.downloads += 1;
      for (let at = 0; at < bytes.length; at += 4096) {
        seen.chunks += 1;
        yield bytes.slice(at, at + 4096);
      }
    },
  } as unknown as ClientApi;
  return { client, seen };
}

const link = { kind: "link", threadId: "t1", itemId: "i1", reference: "/tmp/x" } as const;

it("an unknown linked text file is shown from the one read that sniffed it", async () => {
  const { client, seen } = streaming(new TextEncoder().encode("module example.com/x\n".repeat(50)));
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal, 1024);
  expect(prefix?.text).toBe("module example.com/x\n".repeat(50).slice(0, 1024));
  expect(prefix?.truncated).toBe(true);
  expect(seen.downloads).toBe(1);
});

it("an unknown linked binary stops downloading once its first bytes show it", async () => {
  const binary = new Uint8Array(1024 * 1024).fill(0);
  const { client, seen } = streaming(binary);
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal, 2 << 20);
  expect(prefix).toBeUndefined();
  expect(seen.chunks).toBeLessThanOrEqual(2);
});

it("a short unknown text file reads whole and untruncated", async () => {
  const { client } = streaming(new TextEncoder().encode("FROM node:26\n"));
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal);
  expect(prefix).toEqual({ text: "FROM node:26\n", total: 13, truncated: false });
});
