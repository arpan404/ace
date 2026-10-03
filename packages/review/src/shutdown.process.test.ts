import { Worker } from "node:worker_threads";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { expect, it } from "vitest";
import { ReviewWorker } from "./index.ts";
import { repository } from "./test-support.ts";

it("closing the worker waits for abort cleanup even after the worker thread exits", async () => {
  const repo = await repository();
  const entered = Promise.withResolvers<void>();
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanupGate = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let cleaned = false;
  const worker = new ReviewWorker(
    repo.directory + "/worker.sqlite",
    {
      async fix(_intent, signal) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cleanupStarted.resolve();
              void cleanupGate.promise.then(() => {
                cleaned = true;
                reject(new Error("Canceled"));
              });
            },
            { once: true },
          );
        });
      },
      async review() {
        return { comments: [] };
      },
    },
    {
      createWorker(url, options) {
        const thread = new Worker(url, options);
        thread.once("exit", () => exited.resolve());
        return thread;
      },
    },
  );
  try {
    const opened = await worker.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    const comment = await worker.handle(
      repo.command({
        type: "review.comment",
        sessionId,
        position: { file: "file.ts", side: "new", start: 3, end: 3 },
        text: "Fix",
      }),
    );
    const command = repo.command({
      type: "review.sendToAgent",
      sessionId,
      threadId: "thread",
      commentIds: [comment.review?.comment?.id],
    });
    const pending = worker.handle(command, undefined, repo.target).catch(() => undefined);
    await entered.promise;
    let closed = false;
    const shutdown = worker.close().then(() => {
      closed = true;
    });
    await cleanupStarted.promise;
    await exited.promise;
    // A real I/O checkpoint after exit lets close settle if it wrongly ignores
    // executor cleanup; the cleanup gate remains held throughout.
    await writeFile(join(repo.directory, "worker-exited"), "observed");
    expect(closed).toBe(false);
    cleanupGate.resolve();
    await shutdown;
    expect(cleaned).toBe(true);
    await pending;
  } finally {
    cleanupGate.resolve();
    await worker.close();
    await repo.close();
  }
});

it("closing a review worker drains a live detached Git process and its descendant", async () => {
  const repo = await repository();
  const ready = Promise.withResolvers<{ parent: number; descendant: number }>();
  const pids = z.object({
    parent: z.number().int().positive(),
    descendant: z.number().int().positive(),
  });
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (bytes: Buffer) => {
      data += bytes.toString();
    });
    socket.on("end", () => ready.resolve(pids.parse(JSON.parse(data))));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing child fixture address");
  const descendant = join(repo.directory, "git-descendant.cjs");
  const binary = join(repo.directory, "git-fixture.cjs");
  await writeFile(descendant, "process.send({ready:true}); setInterval(()=>{},1000);");
  await writeFile(
    binary,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--version')) process.stdout.write('git version 2.40.0\\n');
else {
 const child=require('node:child_process').fork(${JSON.stringify(descendant)},[],{stdio:['ignore',process.stdout,process.stderr,'ipc']});
 child.once('message',()=>{
  const socket=require('node:net').connect(${address.port},'127.0.0.1',()=>socket.end(JSON.stringify({parent:process.pid,descendant:child.pid})));
 });
}
`,
  );
  await chmod(binary, 0o755);
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite", undefined, {
    gitBinary: binary,
  });
  let child: { parent: number; descendant: number } | undefined;
  try {
    const pending = worker
      .handle(repo.command({ type: "review.open", source: repo.session.source }), repo.root)
      .catch(() => undefined);
    child = await ready.promise;
    const running = child;
    await worker.close();
    await pending;
    expect(() => process.kill(running.parent, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    // A killed orphan may be a zombie until the OS reaps it, but cannot be live.
    const state = await promisify(execFile)("ps", [
      "-o",
      "stat=",
      "-p",
      String(child.descendant),
    ]).catch((error: unknown) => {
      expect(error).toMatchObject({ code: 1, stdout: "" });
      return { stdout: "" };
    });
    expect(state.stdout.trim()).toMatch(/^(?:Z[^\n]*|\?E[^\n]*)?$/);
  } finally {
    if (child)
      for (const pid of [child.parent, child.descendant]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    await worker.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await repo.close();
  }
});
