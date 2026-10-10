import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { fixture, token } from "./socket-test-support.ts";
import { installFixture } from "./provider-install/testing.ts";

test("a slow install plan leaves the socket available for other requests", async () => {
  const arrived = Promise.withResolvers<void>();
  const unblocked = Promise.withResolvers<void>();
  let release = () => unblocked.resolve();
  const barrier = createServer((_request, response) => {
    release = () => response.end("2.0.0");
    arrived.resolve();
  });
  barrier.listen(0, "127.0.0.1");
  await once(barrier, "listening");
  const address = barrier.address();
  if (!address || typeof address === "string") throw new Error("Missing barrier address");
  const f = await installFixture({ managers: ["npm"] });
  const driver = join(f.bin, "npm-driver.mjs");
  await writeFile(driver, await readFile(join(f.bin, "npm"), "utf8"));
  await writeFile(
    join(f.bin, "npm"),
    `#!${process.execPath}\nif(process.argv[2]==='view') console.log(await (await fetch('http://127.0.0.1:${address.port}')).text()); else await import('./npm-driver.mjs');\n`,
    { mode: 0o755 },
  );
  const h = await fixture({ providerInstalls: f.installs });
  try {
    const client = await h.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("install-client"),
      token,
    });
    await client.next();
    client.send({
      type: "provider.install.plan",
      requestId: "slow",
      provider: "codex",
      action: "install",
    });
    await arrived.promise;
    client.send({ type: "ping" });
    expect(await client.next()).toMatchObject({ type: "pong" });
    release();
    expect(await client.next()).toMatchObject({
      type: "provider.install.result",
      requestId: "slow",
      result: { ok: true },
    });
  } finally {
    release();
    await h.close();
    await f.close();
    await new Promise<void>((done) => barrier.close(() => done()));
  }
});
