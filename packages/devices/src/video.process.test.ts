import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { framePacket, type RecordingArtifact } from "@ace/screen";
import { BrowserRecording } from "@ace/browser";
import { renderDeviceVideo } from "./video.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture(mode = "success") {
  const directory = await mkdtemp(join(tmpdir(), "ace-device-video-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "ffmpeg");
  const script = `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
if (mode === "fail") process.exit(1);
const concat = readFileSync("frames.ffconcat", "utf8");
const files = [...concat.matchAll(/file '([^']+)'/g)].map((match) => match[1]);
const images = files.map((file) => readFileSync(file).toString("hex"));
if (mode === "oversize") {
  const { openSync, ftruncateSync, closeSync } = await import("node:fs");
  const fd = openSync("recording.mp4", "w"); ftruncateSync(fd, 50 * 1024 * 1024 + 1); closeSync(fd);
} else {
  const header = Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  writeFileSync("recording.mp4", Buffer.concat([header, Buffer.from(JSON.stringify({ concat, images }))]));
}
`;
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  return { directory, executable, env: { PATH: directory } };
}
function packet(sequence: number, timestamp: number, version: 1 | 2 = 1) {
  const payload = Buffer.from([255, 216, sequence, 255, 217]);
  return framePacket(
    version === 1
      ? {
          version,
          sessionId: "capture",
          sequence,
          timestamp,
          width: 320,
          height: 640,
          codec: "jpeg",
          bytes: payload.length,
        }
      : {
          version,
          sessionId: "capture",
          seq: sequence,
          ts: timestamp,
          width: 320,
          height: 640,
          scale: 1,
          codec: "jpeg",
          bytes: payload.length,
        },
    payload,
  );
}
async function source(directory: string, data: Buffer): Promise<RecordingArtifact> {
  const path = join(directory, "artifact.ace-screen");
  await writeFile(path, data);
  return { id: "artifact", path, bytes: data.length, mimeType: "application/vnd.ace.screen" };
}
it("passes every v1 and v2 JPEG byte and timestamp to the encoder and removes intermediates", async () => {
  const f = await fixture();
  const artifact = await source(
    f.directory,
    Buffer.concat([packet(0, 1000), packet(1, 1100, 2), packet(2, 1350, 2)]),
  );
  const result = await renderDeviceVideo(artifact, f.env);
  expect(result).toMatchObject({
    id: artifact.id,
    path: join(f.directory, "artifact.mp4"),
    mimeType: "video/mp4",
  });
  const output = await readFile(result.path);
  const evidence = z
    .object({ concat: z.string(), images: z.array(z.string()) })
    .parse(JSON.parse(output.subarray(24).toString()));
  expect(evidence.concat).toContain("file '1.jpg'\nduration 0.1\nfile '2.jpg'\nduration 0.25\n");
  expect(evidence.images).toEqual(["ffd800ffd9", "ffd801ffd9", "ffd802ffd9", "ffd802ffd9"]);
  expect(result.bytes).toBe(output.length);
  expect((await readdir(f.directory)).toSorted()).toEqual([
    "artifact.ace-screen",
    "artifact.mp4",
    "ffmpeg",
  ]);
  expect((await stat(artifact.path)).size).toBe(artifact.bytes);
});
it("preserves the custom recording and removes intermediates when ffmpeg fails", async () => {
  const f = await fixture("fail");
  const bytes = packet(0, 0);
  const artifact = await source(f.directory, bytes);
  await expect(renderDeviceVideo(artifact, f.env)).rejects.toMatchObject({
    code: "command_failed",
  });
  expect(await readFile(artifact.path)).toEqual(bytes);
  expect((await readdir(f.directory)).toSorted()).toEqual(["artifact.ace-screen", "ffmpeg"]);
});
it("rejects missing ffmpeg with an installation hint without deleting the recording", async () => {
  const f = await fixture();
  const artifact = await source(f.directory, packet(0, 0));
  await expect(
    renderDeviceVideo(artifact, { PATH: join(f.directory, "missing") }),
  ).rejects.toMatchObject({
    code: "tool_missing",
    hint: expect.stringContaining("Install ffmpeg"),
  });
  expect((await stat(artifact.path)).size).toBe(artifact.bytes);
});
for (const [name, data] of [
  ["oversized header", Buffer.from([0, 0, 16, 1])],
  ["truncated length", Buffer.from([0, 0, 0])],
  ["truncated payload", packet(0, 0).subarray(0, -1)],
  ["invalid header JSON", Buffer.from([0, 0, 0, 1, 123])],
  ["invalid header schema", Buffer.from([0, 0, 0, 2, 123, 125])],
  ["out of order frames", Buffer.concat([packet(1, 100), packet(0, 0)])],
] as const)
  it(`rejects ${name} before encoding and retains the source`, async () => {
    const f = await fixture();
    const artifact = await source(f.directory, data);
    await expect(renderDeviceVideo(artifact, f.env)).rejects.toMatchObject({
      code: "invalid_data",
    });
    expect(await readFile(artifact.path)).toEqual(data);
    expect((await readdir(f.directory)).toSorted()).toEqual(["artifact.ace-screen", "ffmpeg"]);
  });
it("rejects oversized source and encoder output by actual file size", async () => {
  const f = await fixture("oversize");
  const artifact = await source(f.directory, packet(0, 0));
  await expect(renderDeviceVideo(artifact, f.env)).rejects.toMatchObject({ code: "limit" });
  expect((await readdir(f.directory)).toSorted()).toEqual(["artifact.ace-screen", "ffmpeg"]);
  const file = await open(artifact.path, "r+");
  await file.truncate(50 * 1024 * 1024 + 1);
  await file.close();
  await expect(
    renderDeviceVideo({ ...artifact, bytes: 50 * 1024 * 1024 + 1 }, f.env),
  ).rejects.toMatchObject({ code: "limit" });
});
it("rejects path-traversing artifact ids without reading or removing another artifact", async () => {
  const f = await fixture();
  const artifact = await source(f.directory, packet(0, 0));
  await expect(renderDeviceVideo({ ...artifact, id: "../other" }, f.env)).rejects.toMatchObject({
    code: "invalid_data",
  });
  expect((await stat(artifact.path)).size).toBe(artifact.bytes);
});
it("flush waits for the admitted image and surfaces disk write failure", async () => {
  const f = await fixture();
  const directory = join(f.directory, "flush");
  const recording = await BrowserRecording.start(directory, undefined);
  await mkdir(join(directory, "1.jpg"));
  expect(
    recording.accept({
      sequence: 0,
      timestamp: 0,
      width: 320,
      height: 640,
      data: Buffer.from([255, 216, 255, 217]).toString("base64"),
    }),
  ).toBe(true);
  await expect(recording.flush()).rejects.toThrow();
  await expect(recording.stop()).rejects.toThrow();
});

it("rejects nonregular sources and mismatched artifact metadata", async () => {
  const f = await fixture();
  const artifact = await source(f.directory, packet(0, 0));
  await expect(
    renderDeviceVideo({ ...artifact, bytes: artifact.bytes + 1 }, f.env),
  ).rejects.toMatchObject({ code: "invalid_data" });
  await expect(renderDeviceVideo({ ...artifact, path: f.directory }, f.env)).rejects.toMatchObject({
    code: "invalid_data",
  });
  expect((await stat(artifact.path)).size).toBe(artifact.bytes);
});

it("binary recording admission preserves JPEG bytes and refuses an exhausted frame budget", async () => {
  const f = await fixture();
  const directory = join(f.directory, "binary");
  const recording = await BrowserRecording.start(directory, undefined, 4);
  const jpeg = Uint8Array.from([255, 216, 255, 217]);
  expect(recording.acceptJpeg(10, jpeg)).toBe(true);
  await recording.flush();
  expect(await readFile(join(directory, "1.jpg"))).toEqual(Buffer.from(jpeg));
  expect(recording.acceptJpeg(20, jpeg)).toBe(false);
  const result = await recording.stop();
  expect(result.mimeType).toBe("text/html");
  expect(await readFile(join(directory, "frames.jsonl"), "utf8")).toBe(
    '{"file":"1.jpg","timestamp":10}\n',
  );
});
