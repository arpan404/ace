import { ThreadId } from "@ace/protocol";
import { openPiSession, type PiOptions } from "./session.ts";
import { checkedSessionReference } from "./session-header.ts";

/** Cold history operation: only a bounded header is read; Pi owns all tree copying. */
export async function forkPiSession(
  input: { nativeSessionId: string; signal: AbortSignal },
  options: PiOptions,
): Promise<string> {
  input.signal.throwIfAborted();
  const source = await checkedSessionReference(input.nativeSessionId);
  input.signal.throwIfAborted();
  const coldOptions = { ...options };
  delete coldOptions.openMcp;
  const session = await openPiSession(
    {
      threadId: ThreadId.parse("pi-native-fork"),
      cwd: source.cwd,
      signal: input.signal,
      resume: { nativeSessionId: input.nativeSessionId },
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
