import type { spawnRawSupervised } from "@ace/provider-kit/process";
import { boundedClipboard, clipboardLimit, type ClipboardRead } from "./clipboard.ts";
import { DeviceError } from "./sdk.ts";

/** How one Simulator's pasteboard is reached: `xcrun simctl pbcopy|pbpaste <udid>`. */
export type SimulatorPasteboard = {
  spawn: typeof spawnRawSupervised;
  xcrun: string;
  udid: string;
  env: NodeJS.ProcessEnv;
  after(ms: number, run: () => void): () => void;
};

const timeoutMs = 10_000;
/** UTF-8 bytes that always hold `clipboardLimit` UTF-16 units; anything past it is cut. */
const readBytes = clipboardLimit * 4 + 4;

/** Runs one simctl pasteboard command, feeding `input` on stdin and keeping stdout exactly. */
async function pasteboard(
  options: SimulatorPasteboard,
  verb: "pbcopy" | "pbpaste",
  input: string,
): Promise<{ bytes: Buffer; cut: boolean }> {
  const child = options.spawn({
    command: options.xcrun,
    args: ["simctl", verb, options.udid],
    // Without a UTF-8 locale pbcopy reads stdin as MacRoman and mangles anything non-ASCII; a
    // daemon started by launchd usually has no LANG at all.
    env: { ...options.env, LC_ALL: "en_US.UTF-8" },
    name: `simulator-${verb}`,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let cut = false;
  let timedOut = false;
  child.stdout.on("data", (chunk: unknown) => {
    if (cut || !Buffer.isBuffer(chunk)) return;
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > readBytes) {
      cut = true;
      void child.stop({ graceMs: 0 });
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const cancel = options.after(timeoutMs, () => {
    timedOut = true;
    void child.stop({ graceMs: 0 });
  });
  try {
    child.stdin.end(input);
    const exit = await child.exited;
    if (timedOut)
      throw new DeviceError(
        "timeout",
        `Simulator ${verb} did not finish`,
        "Check that the Simulator is booted and responding, then retry.",
      );
    if (!cut && exit.code !== 0)
      throw new DeviceError(
        "command_failed",
        `Simulator ${verb} failed`,
        "Check that the Simulator is booted, then retry.",
      );
    return { bytes: Buffer.concat(chunks).subarray(0, readBytes), cut };
  } finally {
    cancel();
  }
}

/** The Simulator pasteboard's text, as the device holds it (no trimming), bounded. */
export async function simulatorPaste(options: SimulatorPasteboard): Promise<ClipboardRead> {
  const { bytes, cut } = await pasteboard(options, "pbpaste", "");
  return boundedClipboard(bytes.toString("utf8"), cut);
}

/** Replaces the Simulator pasteboard with `text`. */
export async function simulatorCopy(options: SimulatorPasteboard, text: string): Promise<void> {
  await pasteboard(options, "pbcopy", text);
}
