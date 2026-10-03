import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import { openPiSession, type PiOptions } from "./session.ts";

const Path = z.string().min(1).max(8192).refine(isAbsolute, "Expected an absolute session path");
const Header = z.looseObject({
  type: z.literal("session"),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  cwd: Path,
});

/** Cold history operation: only a bounded header is read; Pi owns all tree copying. */
export async function forkPiSession(
  input: { nativeSessionId: string; signal: AbortSignal },
  options: PiOptions,
): Promise<string> {
  input.signal.throwIfAborted();
  const source = Path.parse(input.nativeSessionId);
  const file = await open(source, "r");
  let cwd: string;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error("Pi session header is missing or exceeds 64 KiB");
    cwd = Header.parse(JSON.parse(buffer.toString("utf8", 0, end))).cwd;
  } finally {
    await file.close();
  }
  input.signal.throwIfAborted();
  const coldOptions = { ...options };
  delete coldOptions.openMcp;
  const session = await openPiSession(
    {
      threadId: ThreadId.parse("pi-native-fork"),
      cwd,
      signal: input.signal,
      resume: { nativeSessionId: source },
      onFrame() {},
      onExit() {},
    },
    coldOptions,
  );
  try {
    return (await session.fork()).nativeSessionId;
  } finally {
    await session.close("idle");
  }
}
