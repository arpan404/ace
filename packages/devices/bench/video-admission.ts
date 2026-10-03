import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BrowserRecording } from "@ace/browser";

// Non-gating disk admission comparison; no codec or playback claim. Run at merge only.
const payload = Buffer.alloc(128 * 1024, 42);
const base64 = payload.toString("base64");
const directory = await mkdtemp(join(tmpdir(), "ace-video-admission-bench-"));
try {
  for (const mode of ["base64", "binary"] as const) {
    const recording = await BrowserRecording.start(
      join(directory, mode),
      undefined,
      50 * 1024 * 1024,
    );
    const count = 256;
    const started = performance.now();
    for (let sequence = 0; sequence < count; sequence++) {
      const accepted =
        mode === "binary"
          ? recording.acceptJpeg(sequence, payload)
          : recording.accept({
              sequence,
              timestamp: sequence,
              width: 1080,
              height: 1920,
              data: base64,
            });
      if (!accepted) throw new Error("Benchmark frame was not admitted");
      await recording.flush();
    }
    await recording.stop();
    const elapsed = performance.now() - started;
    process.stdout.write(
      `${mode} 128 KiB JPEG disk admission: ${((count / elapsed) * 1000).toFixed(0)} ops/s, ${((elapsed * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
