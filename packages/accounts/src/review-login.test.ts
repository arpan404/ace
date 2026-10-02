import { afterEach, expect, test } from "vitest";
import { createServer } from "node:net";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { addAccount, createInstance, openRegistry, discoverHomes } from "./index.ts";
import { cleanup, temp } from "./test-support.ts";
afterEach(cleanup);
test("cancelled login waits until a CLI ignoring SIGTERM has been reaped", async () => {
  const root = await temp();
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  let pid: number | undefined;
  const server = createServer();
  const ready = new Promise<void>((resolve) =>
    server.once("connection", (socket) => {
      socket.once("data", (data) => {
        pid = Number(data.toString());
        socket.destroy();
        resolve();
      });
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  await writeFile(
    join(root, "codex"),
    `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.includes('--version'))console.log('0.159.1');else if(args.includes('status'))console.log('Not logged in');else {process.on('SIGTERM',()=>{});require('node:net').connect(${address.port},'127.0.0.1',function(){this.write(String(process.pid));});setInterval(()=>{},1000);}`,
    { mode: 0o755 },
  );
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  const signal = new AbortController();
  const result = addAccount(
    registry,
    createInstance({ id: "a", provider: "codex", label: "a", homeDir: join(root, "home") }),
    {
      now: () => 1,
      discovery: { env: { PATH: root } },
      signal: signal.signal,
      cancellationGraceMs: 0,
    },
  ).catch((error) => error);
  try {
    await ready;
    signal.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(() => {
      if (pid !== undefined) process.kill(pid, 0);
    }).toThrow();
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    server.close();
    registry.close();
  }
});
test("an invalid conventional directory does not prevent discovery of valid homes", async () => {
  const root = await temp();
  await mkdir(join(root, ".codex"));
  await mkdir(join(root, `.codex-${"x".repeat(150)}`));
  expect((await discoverHomes(root)).map((a) => a.id)).toEqual(["codex"]);
});
