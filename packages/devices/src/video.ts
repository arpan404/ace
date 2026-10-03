import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdtemp, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserRecording, type ProcessSpawner } from "@ace/browser";
import { ScreenFrameHeader, ScreenId } from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";
import type { RecordingArtifact } from "@ace/screen";
import { DeviceError } from "./sdk.ts";

const limit = 50 * 1024 * 1024;
/** Positional reads retain one bounded header or JPEG, never recording history. */
async function exact(
  file: FileHandle,
  position: number,
  length: number,
  size: number,
): Promise<Buffer> {
  if (position + length > size) throw invalid("Device recording is truncated");
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const read = await file.read(bytes, filled, length - filled, position + filled);
    if (!read.bytesRead) throw invalid("Device recording ended before its declared frame size");
    filled += read.bytesRead;
  }
  return bytes;
}
function invalid(message: string): DeviceError {
  return new DeviceError("invalid_data", message, "Capture the device recording again.");
}
async function frameHeader(file: FileHandle, position: number, size: number) {
  const length = (await exact(file, position, 4, size)).readUInt32BE();
  if (!length || length > 4096) throw invalid("Device frame header exceeds 4096 bytes");
  let raw: unknown;
  try {
    raw = JSON.parse((await exact(file, position + 4, length, size)).toString("utf8"));
  } catch {
    throw invalid("Device frame header is not valid JSON");
  }
  const result = ScreenFrameHeader.safeParse(raw);
  if (!result.success) throw invalid("Device frame header violates the shared screen protocol");
  const payloadPosition = position + 4 + length;
  const nextPosition = payloadPosition + result.data.bytes;
  if (nextPosition > size) throw invalid("Device recording has a truncated JPEG");
  return { header: result.data, payloadPosition, nextPosition };
}
export async function renderDeviceVideo(
  artifact: RecordingArtifact,
  env: NodeJS.ProcessEnv,
  options: { spawn?: ProcessSpawner; ffmpeg?: string } = {},
): Promise<{ id: string; path: string; bytes: number; mimeType: "video/mp4" }> {
  const parsed = ScreenId.safeParse(artifact.id);
  if (!parsed.success) throw invalid("Invalid device recording identifier");
  const ffmpeg = await findExecutable(options.ffmpeg ?? "ffmpeg", env);
  if (!ffmpeg)
    throw new DeviceError(
      "tool_missing",
      "ffmpeg is required to encode device video",
      "Install ffmpeg on the daemon host and add it to PATH.",
    );
  let source: FileHandle | undefined;
  let directory: string | undefined;
  let recording: BrowserRecording | undefined;
  let closing: ReturnType<BrowserRecording["stop"]> | undefined;
  const stop = () => {
    if (!recording) throw new Error("Recording encoder was not started");
    closing ??= recording.stop();
    return closing;
  };
  try {
    const file = await open(
      artifact.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    source = file;
    const info = await file.stat();
    if (!info.isFile()) throw invalid("Device recording is not a regular file");
    if (info.size > limit)
      throw new DeviceError(
        "limit",
        "Device recording exceeds 50 MiB",
        "Make a shorter recording.",
      );
    if (info.size === 0) throw invalid("Device recording has no frames");
    if (info.size !== artifact.bytes)
      throw invalid("Device recording size differs from its artifact metadata");
    // Validate framing before admitting any image to the encoder. This pass skips
    // payloads by position; the second pass reads each JPEG exactly once.
    let count = 0;
    let lastSequence = -1;
    let lastTimestamp = -1;
    let sessionId: string | undefined;
    for (let position = 0; position < info.size;) {
      const { header, nextPosition } = await frameHeader(file, position, info.size);
      const sequence = header.version === 1 ? header.sequence : header.seq;
      const timestamp = header.version === 1 ? header.timestamp : header.ts;
      sessionId ??= header.sessionId;
      if (header.sessionId !== sessionId || sequence <= lastSequence || timestamp < lastTimestamp)
        throw invalid("Device recording frames are out of order or belong to different captures");
      if (++count > 100_000)
        throw new DeviceError(
          "limit",
          "Device recording exceeds 100,000 frames",
          "Make a shorter recording.",
        );
      lastSequence = sequence;
      lastTimestamp = timestamp;
      position = nextPosition;
    }
    directory = await mkdtemp(join(dirname(artifact.path), `.${parsed.data}-video-`));
    recording = await BrowserRecording.start(directory, ffmpeg, limit, (command, args, launch) =>
      (options.spawn ?? spawn)(command, args, { ...launch, env: { ...process.env, ...env } }),
    );
    let previousSequence = -1;
    let previousTimestamp = -1;
    for (let position = 0; position < info.size;) {
      const { header, payloadPosition, nextPosition } = await frameHeader(
        file,
        position,
        info.size,
      );
      const sequence = header.version === 1 ? header.sequence : header.seq;
      const timestamp = header.version === 1 ? header.timestamp : header.ts;
      if (sequence <= previousSequence || timestamp < previousTimestamp)
        throw invalid("Device recording frames are out of order");
      const payload = await exact(file, payloadPosition, header.bytes, info.size);
      if (
        !recording.accept({
          sequence,
          timestamp,
          width: header.width,
          height: header.height,
          data: payload.toString("base64"),
        })
      )
        throw new DeviceError(
          "limit",
          "Device recording exceeds the encoder's bounded frame budget",
          "Make a shorter recording.",
        );
      await recording.flush();
      previousSequence = sequence;
      previousTimestamp = timestamp;
      position = nextPosition;
    }
    const encoded = await stop();
    if (encoded.mimeType !== "video/mp4")
      throw new DeviceError(
        "command_failed",
        "ffmpeg could not encode the device recording",
        "Verify ffmpeg includes the libx264 encoder, then retry.",
      );
    const result = await stat(encoded.path);
    if (!result.isFile() || result.size === 0 || result.size > limit)
      throw new DeviceError(
        "limit",
        "Encoded device video exceeds 50 MiB",
        "Make a shorter recording.",
      );
    const path = join(dirname(artifact.path), `${parsed.data}.mp4`);
    await rename(encoded.path, path);
    // The daemon removes the source only after the MP4 artifact is registered.
    return { id: parsed.data, path, bytes: result.size, mimeType: "video/mp4" };
  } catch (error) {
    if (error instanceof DeviceError) throw error;
    throw new DeviceError(
      "command_failed",
      "Device video conversion failed",
      "Verify the recording and ffmpeg installation, then retry.",
    );
  } finally {
    if (recording) await stop().catch(() => {});
    await source?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
