import { expect, test } from "vitest";
import { once } from "node:events";
import { PreviewLaunch } from "@ace/protocol/preview";
import { createLaunchManager } from "./index.ts";
import { http, serve } from "./test-support.ts";

test("autoPort starts a real owned server with PORT, cwd and env then stops it", async () => {
  const manager = createLaunchManager({ root: process.cwd() });
  const launch = PreviewLaunch.parse({
    name: "dev",
    runtimeExecutable: process.execPath,
    autoPort: true,
    env: { PREVIEW_VALUE: "injected" },
    args: [
      "-e",
      `require('node:http').createServer((req,res)=>res.end(process.env.PREVIEW_VALUE+':'+process.cwd())).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ready'))`,
    ],
  });
  try {
    const handle = await manager.start(launch);
    if (!handle.process || !handle.url) throw new Error("Missing running launch");
    await once(handle.process.stdout, "line");
    expect((await http(handle.url)).body).toBe(`injected:${process.cwd()}`);
    await expect(manager.start(launch)).rejects.toThrow("already active");
    await handle.stop();
    expect((await handle.process.exited).reason).toBe("stopped");
    await expect(http(handle.url)).rejects.toThrow();
    expect(manager.list()).toEqual([]);
  } finally {
    await manager.close();
  }
});

test("attach configurations leave the existing server running after stop", async () => {
  const upstream = await serve((_req, res) => res.end("existing"));
  const manager = createLaunchManager({ root: process.cwd() });
  try {
    const handle = await manager.start(
      PreviewLaunch.parse({ name: "attached", url: upstream.url }),
    );
    expect((await http(handle.url ?? "")).body).toBe("existing");
    await handle.stop();
    expect((await http(upstream.url)).body).toBe("existing");
    await expect(
      manager.start(PreviewLaunch.parse({ name: "bad", url: "http://example.com" })),
    ).rejects.toThrow("loopback");
  } finally {
    await manager.close();
    await upstream.close();
  }
});

test("natural process exits remove the launch and shutdown rejects new starts", async () => {
  const manager = createLaunchManager({ root: process.cwd() });
  const launch = PreviewLaunch.parse({
    name: "short",
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
  });
  const handle = await manager.start(launch);
  expect(manager.list()).toEqual([{ name: "short", url: undefined }]);
  expect((await handle.process?.exited)?.code).toBe(3);
  expect(manager.list()).toEqual([]);
  await manager.close();
  await expect(manager.start(launch)).rejects.toThrow("closed");
});

test.each(["stdout", "stderr"])(
  "an oversized %s line terminates its owned launch",
  async (stream) => {
    const manager = createLaunchManager({ root: process.cwd() });
    try {
      const handle = await manager.start(
        PreviewLaunch.parse({
          name: "noisy",
          command: process.execPath,
          args: [
            "-e",
            `process.${stream}.write('x'.repeat(4 * 1024 * 1024), () => process.exit(0))`,
          ],
        }),
      );
      expect((await handle.process?.exited)?.signal).toBe("SIGKILL");
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.close();
    }
  },
);

test("launch output can exceed the total cap when LF and CR lines stay small", async () => {
  const manager = createLaunchManager({ root: process.cwd() });
  try {
    const handle = await manager.start(
      PreviewLaunch.parse({
        name: "many-lines",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(('x'.repeat(1023)+'\\n'+'y'.repeat(1023)+'\\r').repeat(2048), () => process.exit(0))",
        ],
      }),
    );
    expect((await handle.process?.exited)?.code).toBe(0);
  } finally {
    await manager.close();
  }
});

test("stop waits for a pending start and leaves no owned server running", async () => {
  const manager = createLaunchManager({ root: process.cwd() });
  try {
    const launching = manager.start(
      PreviewLaunch.parse({
        name: "pending",
        command: process.execPath,
        autoPort: true,
        args: ["-e", "setInterval(()=>{},1000)"],
      }),
    );
    const stopping = manager.stop("pending");
    const handle = await launching;
    await stopping;
    expect(manager.list()).toEqual([]);
    expect((await handle.process?.exited)?.reason).toBe("stopped");
  } finally {
    await manager.close();
  }
});

test("an old launch handle cannot stop a replacement with the same name", async () => {
  const manager = createLaunchManager({ root: process.cwd() });
  const config = PreviewLaunch.parse({
    name: "replacement",
    command: process.execPath,
    autoPort: true,
    args: [
      "-e",
      "require('node:http').createServer((req,res)=>res.end('replacement')).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ready'))",
    ],
  });
  try {
    const old = await manager.start(config);
    if (!old.process) throw new Error("Missing process");
    await once(old.process.stdout, "line");
    await old.stop();
    const current = await manager.start(config);
    if (!current.process || !current.url) throw new Error("Missing replacement");
    await once(current.process.stdout, "line");
    await old.stop();
    expect((await http(current.url)).body).toBe("replacement");
  } finally {
    await manager.close();
  }
});
