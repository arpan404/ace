import type { SessionOptions } from "./session-options.ts";
import type { LiveCapture } from "./live.ts";
import type { SessionQueue } from "./session-queue.ts";
import type { SessionRecording } from "./session-recording.ts";
import type { SessionLogs } from "./logs.ts";

/** Close the transport before waiting on renderer work it must abort. */
export async function closeSession(
  options: SessionOptions,
  live: LiveCapture,
  queue: SessionQueue,
  recordings: SessionRecording,
  logs: SessionLogs,
): Promise<void> {
  try {
    const stopped = live.close();
    try {
      await options.backend.close();
    } finally {
      await stopped;
      await queue.settled();
    }
  } finally {
    try {
      try {
        await recordings.close();
      } finally {
        await logs.close();
      }
    } finally {
      await options.cleanup();
    }
  }
}
