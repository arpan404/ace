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

/** A daemon streaming one linked file in pieces (64 KB, as the real one sends), counting them. */
function streaming(bytes: Uint8Array, piece = 64 * 1024) {
  const seen = { downloads: 0, chunks: 0 };
  const client = {
    async *downloadFile() {
      seen.downloads += 1;
      for (let at = 0; at < bytes.length; at += piece) {
        seen.chunks += 1;
        yield bytes.slice(at, at + piece);
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

it("an unknown linked binary stops downloading after the first piece the daemon sends", async () => {
  const { client, seen } = streaming(new Uint8Array(1024 * 1024));
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal, 2 << 20);
  expect(prefix).toBeUndefined();
  expect(seen.chunks).toBe(1);
});

it("a small display limit never shrinks the sniff below 8 KB", async () => {
  const bytes = new Uint8Array(16 * 1024);
  bytes.fill(0x61, 0, 1024);
  const { client } = streaming(bytes);
  expect(await readTextPrefixIfText(client, link, new AbortController().signal, 1024)).toBe(
    undefined,
  );
});

it("an 8 KB file ending in half a character reads as binary", async () => {
  const bytes = new Uint8Array(8 * 1024).fill(0x61);
  bytes[bytes.length - 1] = 0xc3;
  const { client } = streaming(bytes);
  expect(await readTextPrefixIfText(client, link, new AbortController().signal)).toBe(undefined);
});

it("a character split by the 8 KB mark in a longer file still reads as text", async () => {
  const text = `${"a".repeat(8 * 1024 - 1)}é and more`;
  const { client } = streaming(new TextEncoder().encode(text), 1000);
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal);
  expect(prefix?.text).toBe(text);
});

it("the same bytes read the same from a link and from a local file", async () => {
  // 8 KB of two-byte characters, then a NUL past the sniff.
  const bytes = new TextEncoder().encode(`${"é".repeat(4096)}\u0000tail`);
  const { client } = streaming(bytes);
  const signal = new AbortController().signal;
  const linked = await readTextPrefixIfText(client, link, signal);
  const local = await readTextPrefixIfText(
    client,
    { kind: "file", file: new File([bytes], "x") },
    signal,
  );
  expect(linked).toBeDefined();
  expect(local).toEqual(linked);
});

it("a short unknown text file reads whole and untruncated", async () => {
  const { client } = streaming(new TextEncoder().encode("FROM node:26\n"));
  const prefix = await readTextPrefixIfText(client, link, new AbortController().signal);
  expect(prefix).toEqual({ text: "FROM node:26\n", total: 13, truncated: false });
});
