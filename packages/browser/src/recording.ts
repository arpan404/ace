import { z } from "zod";
import { spawnProcess, type ProcessSpawner } from "./io.ts";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import type { BrowserArtifact, BrowserFrame } from "@ace/protocol";

const Timestamp = z.number().finite().nonnegative();

const player = `<!doctype html><meta name="viewport" content="width=device-width"><title>Browser recording</title>
<button id="play">Play</button><img id="frame" style="max-width:100%"><script>
async function* entries(){const reader=(await fetch('frames.jsonl')).body.getReader();const decoder=new TextDecoder();let tail='';
while(true){const {value,done}=await reader.read();if(done)break;tail+=decoder.decode(value,{stream:true});
let end;while((end=tail.indexOf('\\n'))>=0){yield JSON.parse(tail.slice(0,end));tail=tail.slice(end+1);}}}
document.getElementById('play').onclick=async()=>{const button=document.getElementById('play');button.disabled=true;let previous;
try{for await(const f of entries()){if(previous!==undefined)await new Promise(r=>setTimeout(r,Math.max(0,f.timestamp-previous)));
document.getElementById('frame').src=f.file;previous=f.timestamp;}}finally{button.disabled=false;}};
</script>`;

function append(stream: WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) =>
    stream.write(text, (error) => (error ? reject(error) : resolve())),
  );
}

/** Stream frames to disk first. The manifest preserves timing even after drops.
 * One disk write is in flight; no queue accumulates while disk is slow. */
export class Recording {
  private manifest: WriteStream;
  private concat: WriteStream;
  private busy: Promise<void> | undefined;
  private bytes = 0;
  private count = 0;
  private previous: { file: string; timestamp: number } | undefined;
  private failure: unknown;
  private closed = false;
  private exhausted = false;
  private dir: string;
  private limit: number;
  private spawn: ProcessSpawner;
  private ffmpeg: string | undefined;
  private constructor(
    dir: string,
    ffmpeg: string | undefined,
    limit: number,
    spawn: ProcessSpawner,
  ) {
    this.spawn = spawn;
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.limit = limit;
    this.manifest = createWriteStream(join(dir, "frames.jsonl"), { mode: 0o600 });
    this.concat = createWriteStream(join(dir, "frames.ffconcat"), { mode: 0o600 });
    this.manifest.on("error", (error) => {
      this.failure = error;
    });
    this.concat.on("error", (error) => {
      this.failure = error;
    });
  }
  static async start(
    dir: string,
    ffmpeg: string | undefined,
    limit = 256 * 1024 * 1024,
    spawn: ProcessSpawner = spawnProcess,
  ): Promise<Recording> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "player.html"), player, { mode: 0o600 });
    const recording = new Recording(dir, ffmpeg, limit, spawn);
    await append(recording.concat, "ffconcat version 1.0\n");
    return recording;
  }
  private admissionOpen(): boolean {
    return !(this.closed || this.busy || this.failure || this.exhausted || this.count >= 100_000);
  }
  accept(frame: BrowserFrame): boolean {
    if (!this.admissionOpen()) return false;
    return this.acceptJpeg(frame.timestamp, Buffer.from(frame.data, "base64"));
  }
  /** Admit an owned JPEG without base64 conversion. Keep its bytes unchanged until flush. */
  acceptJpeg(timestamp: number, data: Uint8Array): boolean {
    if (!this.admissionOpen()) return false;
    Timestamp.parse(timestamp);
    if (this.bytes + data.length > this.limit) {
      this.exhausted = true;
      return false;
    }
    this.bytes += data.length;
    const file = `${++this.count}.jpg`;
    this.busy = (async () => {
      await writeFile(join(this.dir, file), data, { mode: 0o600 });
      await append(this.manifest, JSON.stringify({ file, timestamp }) + "\n");
      if (this.previous) {
        const duration = Math.max(
          0.001,
          Math.min(3600, (timestamp - this.previous.timestamp) / 1000),
        );
        await append(this.concat, `file '${this.previous.file}'\nduration ${duration}\n`);
      }
      this.previous = { file, timestamp };
    })()
      .catch((error: unknown) => {
        this.failure = error;
      })
      .finally(() => {
        this.busy = undefined;
      });
    return true;
  }
  /** Await the admitted frame without changing live capture's drop policy. */
  async flush(): Promise<void> {
    await this.busy;
    if (this.failure) throw this.failure;
  }
  async stop(): Promise<BrowserArtifact> {
    this.closed = true;
    await this.busy;
    if (this.previous && !this.failure)
      await append(
        this.concat,
        `file '${this.previous.file}'\nduration 0.067\nfile '${this.previous.file}'\n`,
      );
    await Promise.all(
      [this.manifest, this.concat].map(async (stream) => {
        stream.end();
        await finished(stream);
      }),
    );
    if (this.failure) throw this.failure;
    if (!this.count) throw new Error("Recording has no frames");
    const encoded = this.ffmpeg ? await this.encode(this.ffmpeg) : false;
    const path = join(this.dir, encoded ? "recording.mp4" : "player.html");
    return { path, mimeType: encoded ? "video/mp4" : "text/html", bytes: (await stat(path)).size };
  }
  private encode(ffmpeg: string): Promise<boolean> {
    return new Promise((resolve) => {
      const args = [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "frames.ffconcat",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-fs",
        String(this.limit),
        "-movflags",
        "+faststart",
        "recording.mp4",
      ];
      const encoder = this.spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./encoder-process.ts", import.meta.url)),
          JSON.stringify({ executable: ffmpeg, cwd: this.dir, args }),
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      // The helper kills ffmpeg on stdin EOF if the daemon dies.
      encoder.stdin?.on("error", () => {});
      const timer = setTimeout(() => encoder.kill("SIGTERM"), 120_000);
      encoder.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      encoder.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
}
