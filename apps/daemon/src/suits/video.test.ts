import { mkdir, mkdtemp, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { SuitResponse } from "@ace/protocol/suits";
import { suitsHttp } from "./http.ts";
import { SuitLibrary } from "./library.ts";
import { byteRange } from "./range.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "./watch.ts";

let home: string;
let root: string;
let library: SuitLibrary;
let server: Server;
let origin: string;

const manifest = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 1,
    id: "clip",
    name: "Clip",
    dark: { canvas: "#101014" },
    video: { sources: ["assets/clip.mp4"] },
    ...fields,
  });

/** The video's bytes: 0, 1, 2, … so any range is easy to check. */
const videoBytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
/** Another cut of it, the same size. */
const reversed = Buffer.from([...videoBytes].toReversed());

async function clip(bytes: Buffer = videoBytes) {
  await mkdir(join(root, "clip", "assets"), { recursive: true });
  await writeFile(join(root, "clip", "suit.json"), manifest());
  await writeFile(join(root, "clip", "assets", "clip.mp4"), bytes);
}

async function videoUrl(): Promise<string> {
  const response: SuitResponse = await library.read("clip");
  if (response.op !== "read") throw new Error(JSON.stringify(response));
  const url = response.suit.assets["assets/clip.mp4"];
  if (!url) throw new Error("no video url");
  return origin + url;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-suit-video-"));
  root = join(home, "suits");
  library = new SuitLibrary({
    root,
    key: new Uint8Array(32).fill(7),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
    settleMs: 30,
  });
  await library.start();
  server = createServer(
    suitsHttp(
      () => library,
      new Set(["https://app.example"]),
      (_request, response) => {
        response.statusCode = 418;
        response.end();
      },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  library.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

test("a Suit's video streams by byte range, so the page can seek without fetching it all", async () => {
  await clip();
  const url = await videoUrl();
  const part = await fetch(url, { headers: { range: "bytes=100-199" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-type")).toBe("video/mp4");
  expect(part.headers.get("content-range")).toBe(`bytes 100-199/${videoBytes.length}`);
  expect(part.headers.get("accept-ranges")).toBe("bytes");
  expect(Buffer.from(await part.arrayBuffer())).toEqual(videoBytes.subarray(100, 200));

  const rest = await fetch(url, { headers: { range: "bytes=4000-" } });
  expect(Buffer.from(await rest.arrayBuffer())).toEqual(videoBytes.subarray(4000));

  const whole = await fetch(url);
  expect(whole.status).toBe(200);
  expect(Buffer.from(await whole.arrayBuffer())).toEqual(videoBytes);
});

test("a range past the end is refused with the file's size", async () => {
  await clip();
  const response = await fetch(await videoUrl(), { headers: { range: "bytes=9999-" } });
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe(`bytes */${videoBytes.length}`);
});

test("the page may read the video's frames for colours from an allowed origin, and from no other", async () => {
  await clip();
  const url = await videoUrl();
  const allowed = await fetch(url, {
    headers: { origin: "https://app.example", range: "bytes=0-1" },
  });
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
  const other = await fetch(url, {
    headers: { origin: "https://evil.example", range: "bytes=0-1" },
  });
  expect(other.headers.get("access-control-allow-origin")).toBeNull();
});

test("a video larger than the 20 MB asset total plays, and the Suit passes its checks", async () => {
  await clip();
  // Sparse: 64 MB on paper, nothing written.
  await truncate(join(root, "clip", "assets", "clip.mp4"), 64 * 1024 * 1024);
  const [summary] = await library.list();
  expect(summary?.problems).toEqual([]);
  const response = await fetch(await videoUrl(), { headers: { range: "bytes=-16" } });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(
    `bytes ${64 * 1024 * 1024 - 16}-${64 * 1024 * 1024 - 1}/${64 * 1024 * 1024}`,
  );
});

test("a new cut of the video is a new version, and the old version's URL stops serving", async () => {
  await clip();
  const before = await videoUrl();
  const path = join(root, "clip", "assets", "clip.mp4");
  await writeFile(path, reversed);
  await utimes(path, new Date(), new Date(Date.now() + 5_000));
  expect((await fetch(before, { headers: { range: "bytes=0-1" } })).status).toBe(404);
  const after = await videoUrl();
  expect(after).not.toBe(before);
  const response = await fetch(after, { headers: { range: "bytes=0-1" } });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(reversed.subarray(0, 2));
});

test("a video that is a link to a file outside the Suit is refused and never served", async () => {
  await mkdir(join(root, "clip", "assets"), { recursive: true });
  await writeFile(join(root, "clip", "suit.json"), manifest());
  await writeFile(join(home, "outside.mp4"), videoBytes);
  await symlink(join(home, "outside.mp4"), join(root, "clip", "assets", "clip.mp4"));
  const [summary] = await library.list();
  expect(summary?.problems.length).toBeGreaterThan(0);
  const response = await library.read("clip");
  if (response.op === "read") expect(response.suit.assets["assets/clip.mp4"]).toBeUndefined();
});

test.each([
  ["no header", undefined, undefined],
  ["a closed range", "bytes=10-19", { start: 10, end: 19 }],
  ["an open range", "bytes=90-", { start: 90, end: 99 }],
  ["a suffix", "bytes=-5", { start: 95, end: 99 }],
  ["an end past the file", "bytes=50-500", { start: 50, end: 99 }],
  ["a start past the file", "bytes=100-", "unsatisfiable"],
  ["an empty suffix", "bytes=-0", "unsatisfiable"],
  ["a backwards range (ignored)", "bytes=20-10", undefined],
  ["several ranges (the whole file)", "bytes=0-1,5-6", undefined],
  ["another unit", "items=0-1", undefined],
] as const)("a Range header with %s", (_name, header, expected) => {
  expect(byteRange(header, 100)).toEqual(expected);
});
