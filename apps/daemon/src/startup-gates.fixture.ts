/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads boundary. */
import { Worker, isMainThread } from "node:worker_threads";
import { z } from "zod";

// Process-only I/O gates. Workers inherit --import but never own process IPC.
if (isMainThread) {
  process.channel?.unref();
  const post = Worker.prototype.postMessage;
  const held: (() => void)[] = [];
  let released = false;
  let announced = false;
  Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
    const ack = z.object({ progressAck: z.number() }).safeParse(args[0]);
    if (process.env.ACE_TEST_HOLD_HISTORY === "1" && ack.success && !released) {
      held.push(() => post.apply(this, args));
      if (!announced) {
        announced = true;
        process.send?.({ type: "scanHeld", bytes: process.memoryUsage.rss() });
      }
      return;
    }
    if (ack.success && released) process.send?.({ type: "rss", bytes: process.memoryUsage.rss() });
    const call = z
      .object({ type: z.literal("call"), call: z.object({ method: z.literal("cursor") }) })
      .safeParse(args[0]);
    if (process.env.ACE_TEST_HOLD_NOTIFICATIONS === "1" && call.success) {
      process.send?.({ type: "startupBlocked" });
      return;
    }
    post.apply(this, args);
  };
  process.on("message", (value: unknown) => {
    if (value === "release-history") {
      released = true;
      for (const send of held.splice(0)) send();
    } else if (value === "sample-rss") {
      process.send?.({ type: "rss", bytes: process.memoryUsage.rss() });
    }
  });
  process.channel?.unref();
}
