import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { expect, test } from "vitest";
import { z } from "zod";
import { probeOutput, spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";

test(
  "cancelling a probe closes its real child server before the probe finishes",
  { timeout: 30_000 },
  async ({ onTestFinished }) => {
    const controller = new AbortController();
    const sockets = new Set<Socket>();
    let report: ((text: string) => void) | undefined;
    const ready = new Promise<string>((resolve) => {
      report = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let data = "";
      socket.on("data", (bytes) => {
        data += bytes.toString();
      });
      socket.on("end", () => report?.(data));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing control listener");
    let pid: number | undefined;
    const operation = probeOutput(
      process.execPath,
      [
        "-e",
        `
    const net = require('node:net');
    const server = net.createServer(socket => socket.end('alive'));
    server.listen(0, '127.0.0.1', () => {
      const control = net.connect({ host: '127.0.0.1', port: ${address.port} });
      control.end(JSON.stringify({ pid: process.pid, port: server.address().port }));
    });
  `,
      ],
      { signal: controller.signal },
    );
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    onTestFinished(async () => {
      controller.abort();
      if (!settled && pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error;
        }
      }
      await operation.catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const child = z
      .object({ pid: z.number().int().positive(), port: z.number().int().positive() })
      .parse(JSON.parse(await ready));
    pid = child.pid;
    const before = connect({ host: "127.0.0.1", port: child.port });
    sockets.add(before);
    before.once("close", () => sockets.delete(before));
    expect(String((await once(before, "data"))[0])).toBe("alive");
    before.destroy();
    controller.abort();
    await expect(operation).rejects.toThrow("Probe aborted");
    const after = connect({ host: "127.0.0.1", port: child.port });
    sockets.add(after);
    after.once("close", () => sockets.delete(after));
    expect((await once(after, "error"))[0]).toEqual(
      expect.objectContaining({ code: "ECONNREFUSED" }),
    );
    after.destroy();
  },
);

test("a probe cancelled during injected spawn stops its child before rejecting", async ({
  onTestFinished,
}) => {
  const controller = new AbortController();
  let child: SupervisedProcess | undefined;
  onTestFinished(async () => {
    await child?.stop({ graceMs: 0 });
  });
  const operation = probeOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    spawn(options) {
      child = spawnSupervised(options);
      controller.abort();
      return child;
    },
  });
  await expect(operation).rejects.toThrow("Probe aborted");
  if (!child) throw new Error("Missing owned child");
  expect(await child.exited).toMatchObject({ reason: "stopped" });
});
