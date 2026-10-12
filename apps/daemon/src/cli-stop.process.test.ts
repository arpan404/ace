import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shutdownControl, readShutdownReceipt } from "./shutdown-receipt.ts";
import { startCli } from "./cli-test-support.ts";

test.each(["succeeded", "failed"] as const)(
  "ace stop waits for cleanup and reports a %s shutdown receipt after the listener closes",
  async (state) => {
    const home = await mkdtemp(join(tmpdir(), "ace-stop-receipt-"));
    const cleanup = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const control = shutdownControl(home, {
      id: () => "synthetic-stop",
      now: () => 1000,
      close: () => cleanup.promise,
    });
    const server = createServer((request, response) => {
      if (
        request.url !== "/v1/stop" ||
        request.headers.authorization !== `Bearer ${"1".repeat(64)}`
      ) {
        response.writeHead(403).end();
        return;
      }
      response.once("finish", () => {
        control.start();
        server.close(() => closed.resolve());
      });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(control.request()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    await writeFile(join(home, "daemon-endpoint"), `http://127.0.0.1:${address.port}`);
    await writeFile(join(home, "daemon-token"), "1".repeat(64));
    const cli = startCli(home, ["stop", "--json", "--timeout", "3s"]);
    let completed = false;
    void cli.exited.then(() => {
      completed = true;
    });
    try {
      await closed.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(completed).toBe(false);
      expect(readShutdownReceipt(home)?.state).toBe("pending");
      if (state === "failed") cleanup.reject(new Error("synthetic resource cleanup failure"));
      else cleanup.resolve();
      const output = await cli.exited;
      expect(output.code, output.stderr).toBe(state === "succeeded" ? 0 : 1);
      expect(JSON.parse(output.stdout)).toMatchObject({
        stopped: state === "succeeded",
        receipt: { id: "synthetic-stop", state },
      });
    } finally {
      cli.child.kill("SIGKILL");
      cleanup.resolve();
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
