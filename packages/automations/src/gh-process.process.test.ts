import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { expect, it } from "vitest";
import { createGhClient } from "./index.ts";
import { deferred } from "./service-test-support.ts";
const Message = z.object({
  kind: z.enum(["parent", "descendant"]),
  pid: z.number().int().positive(),
});
function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return;
    throw error;
  }
}
it("rejects abort before parent exit and terminates descendants holding its pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ace-gh-tree-"));
  const binary = join(root, "gh.mjs");
  const ready = { parent: deferred<number>(), descendant: deferred<number>() };
  const closed = { parent: deferred<void>(), descendant: deferred<void>() };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let bytes = "";
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
      if (bytes.includes("\n")) {
        const message = Message.parse(JSON.parse(bytes.trim()));
        socket.removeAllListeners("data");
        socket.once("close", () => closed[message.kind].resolve());
        ready[message.kind].resolve(message.pid);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local port");
  const descendant = `const {connect}=require('node:net');const socket=connect(${address.port},'127.0.0.1',()=>socket.write(JSON.stringify({kind:'descendant',pid:process.pid})+'\\n'));setInterval(()=>{},1000);`;
  writeFileSync(
    binary,
    `#!/usr/bin/env node\nimport {spawn} from 'node:child_process';import {connect} from 'node:net';const socket=connect(${address.port},'127.0.0.1',()=>socket.write(JSON.stringify({kind:'parent',pid:process.pid})+'\\n'));spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);\n`,
  );
  chmodSync(binary, 0o700);
  const controller = new AbortController();
  const client = createGhClient({ binary });
  const outcome = client.get("repos/user/project/issues", undefined, controller.signal).then(
    () => "success",
    () => "rejected",
  );
  const parent = await ready.parent.promise,
    child = await ready.descendant.promise;
  try {
    controller.abort();
    expect(await Promise.race([outcome, closed.parent.promise.then(() => "parent exited")])).toBe(
      "rejected",
    );
    await closed.descendant.promise;
  } finally {
    kill(parent);
    kill(child);
    for (const socket of sockets) socket.destroy();
    await outcome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(["repos/user/project/../../other/project/issues", "repos/user/project/./issues"])(
  "rejects noncanonical endpoint %s before spawning",
  (endpoint) => {
    const client = createGhClient({ binary: process.execPath });
    expect(() => {
      const request = client.get(endpoint);
      void request.catch(() => {});
    }).toThrow("endpoint");
  },
);
it("uses the injected process boundary to read a real bounded response", async () => {
  const { spawnRawSupervised } = await import("@ace/provider-kit/process");
  const client = createGhClient({
    binary: "unused",
    spawn: () =>
      spawnRawSupervised({
        command: process.execPath,
        args: ["-e", "process.stdout.write('HTTP/2 200 OK\\r\\netag: injected\\r\\n\\r\\n[]')"],
        env: {},
        name: "injected-gh",
      }),
  });
  expect(await client.get("repos/user/project/issues")).toEqual({
    status: 200,
    etag: "injected",
    next: undefined,
    data: [],
  });
});
