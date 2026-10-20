import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const Reply = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

/**
 * A test's own Chrome, driven over `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-delimited
 * JSON). It stands in for the person's browser: the test loads ace for Chrome into it the way a
 * person loads an unpacked extension, then acts like the person through its pages.
 */
export async function launchTestChrome(
  executable: string,
  userDataDir: string,
  /** More flags, such as a larger screen and window. */
  extraArgs: readonly string[] = [],
) {
  const child: ChildProcess = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 400) stderr.push(chunk.toString());
  });
  const writer = child.stdio[3] as Writable;
  const reader = child.stdio[4] as Readable;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let buffered = Buffer.alloc(0);
  reader.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end !== -1; end = buffered.indexOf(0)) {
      const text = buffered.subarray(0, end).toString("utf8");
      buffered = buffered.subarray(end + 1);
      const reply = Reply.safeParse(JSON.parse(text));
      if (!reply.success) continue;
      const waiter = pending.get(reply.data.id);
      pending.delete(reply.data.id);
      if (reply.data.error) waiter?.reject(new Error(reply.data.error.message));
      else waiter?.resolve(reply.data.result);
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<unknown> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      writer.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  };
  await send("Browser.getVersion");
  return {
    send,
    stderr,
    /** Evaluates in a page target and returns its value, awaiting promises. */
    async evaluate(targetId: string, expression: string): Promise<unknown> {
      const { sessionId } = z
        .object({ sessionId: z.string() })
        .parse(await send("Target.attachToTarget", { targetId, flatten: true }));
      try {
        const result = z
          .object({
            result: z.object({ value: z.unknown().optional() }),
            exceptionDetails: z.object({ text: z.string() }).optional(),
          })
          .parse(
            await send(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              sessionId,
            ),
          );
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      } finally {
        await send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    },
    async targets() {
      return z
        .object({
          targetInfos: z.array(
            z.object({ targetId: z.string(), type: z.string(), url: z.string() }),
          ),
        })
        .parse(await send("Target.getTargets")).targetInfos;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      void send("Browser.close").catch(() => {});
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
