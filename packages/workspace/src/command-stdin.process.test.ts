import { expect, it } from "vitest";
import { command } from "./process.ts";
import { workspaceRuntime, type WorkspaceRuntime } from "./runtime.ts";

function trackedRuntime(onClose: () => void): WorkspaceRuntime {
  const base = workspaceRuntime();
  return {
    ...base,
    spawn: (binary, args, options) => {
      const child = base.spawn(binary, args, options);
      child.once("close", onClose);
      return child;
    },
  };
}

async function* large(): AsyncGenerator<Buffer> {
  for (let index = 0; index < 200; index++) {
    await Promise.resolve();
    yield Buffer.alloc(8192, "x");
  }
}

async function* megabytes(): AsyncGenerator<Buffer> {
  for (let index = 0; index < 256; index++) {
    await Promise.resolve();
    yield Buffer.alloc(16 * 1024, "y");
  }
}

it("preserves Unicode across split stdin chunks", async () => {
  const text = "héllo 🌍\nsecond line ☃\nthird 𝄞\n";
  const bytes = Buffer.from(text, "utf8");
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += 2) {
      await Promise.resolve();
      yield bytes.subarray(offset, Math.min(offset + 2, bytes.length));
    }
  }
  const result = await command(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    input: chunks(),
  });
  expect(result.code).toBe(0);
  expect(result.stdout.toString("utf8")).toBe(text);
});

it("rejects with the generator error while reaping the child", async () => {
  const boom = new Error("stdin generator boom");
  let closed = false;
  async function* failing(): AsyncGenerator<Buffer> {
    yield Buffer.from("partial\n");
    await Promise.resolve();
    throw boom;
  }
  await expect(
    command(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: failing() },
      trackedRuntime(() => {
        closed = true;
      }),
    ),
  ).rejects.toBe(boom);
  expect(closed).toBe(true);
});

it("aborts active streaming input without leaking the child", async () => {
  let closed = false;
  const runtime = trackedRuntime(() => {
    closed = true;
  });
  const controller = new AbortController();
  const handshake = Promise.withResolvers<void>();
  const operation = command(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    {
      input: large(),
      signal: controller.signal,
      onChunk: () => {
        handshake.resolve();
        return true;
      },
    },
    runtime,
  );
  const rejected = expect(operation).rejects.toMatchObject({ code: "ABORTED" });
  await handshake.promise;
  controller.abort();
  await rejected;
  expect(closed).toBe(true);
});

it("resolves when the child acknowledges and exits before draining stdin", async () => {
  let closed = false;
  const result = await command(
    process.execPath,
    ["-e", 'process.stdout.write("ack\\n", () => process.exit(0))'],
    { input: megabytes() },
    trackedRuntime(() => {
      closed = true;
    }),
  );
  expect(result.code).toBe(0);
  expect(result.stdout.toString("utf8")).toBe("ack\n");
  expect(closed).toBe(true);
});

it("preserves an input failure even when its error code resembles a closed child pipe", async () => {
  const failure = Object.assign(new Error("producer pipe failed"), { code: "EPIPE" });
  async function* input(): AsyncGenerator<Buffer> {
    yield Buffer.from("partial");
    throw failure;
  }
  await expect(
    command(process.execPath, ["-e", "process.stdin.resume()"], { input: input() }),
  ).rejects.toBe(failure);
});
