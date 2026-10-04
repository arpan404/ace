import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "./socket-test-support.ts";
import { openRegistry, createInstance } from "@ace/accounts";
import { createLogger } from "@ace/diagnostics";
import { startProviderStatuses } from "./services/provider-status.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import type { ServiceContext } from "./services/types.ts";

test("SDK discovery reports its selected registered account's isolated auth status over the socket and never starts a conversation", async () => {
  const f = await fixture();
  const resources = new Resources();
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const entry = join(f.home, "sdk-status.mjs");
    const selectedHome = join(f.home, "sdk-instance");
    const sdkRoot = join(f.home, "sdk");
    const helper = join(f.home, "helper");
    await mkdir(sdkRoot);
    await mkdir(helper);
    await mkdir(join(helper, "bin"));
    await writeFile(join(sdkRoot, "package.json"), '{"name":"@cursor/sdk","version":"1.0.35"}');
    await writeFile(
      join(helper, "package.json"),
      '{"name":"@cursor/sdk-darwin-arm64","version":"1.0.35"}',
    );
    for (const binary of ["rg", "cursorsandbox"])
      await writeFile(join(helper, "bin", binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      entry,
      `
import { createInterface } from 'node:readline';
import { readFile, appendFile } from 'node:fs/promises';
createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  await appendFile(${JSON.stringify(join(f.home, "sdk-calls"))}, request.method + ':' + process.env.HOME + '\\n');
  if (request.method !== 'status') process.exit(90);
  const status = await readFile(${JSON.stringify(join(f.home, "sdk-safe-status"))}, 'utf8');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status, source: status === 'logged-in' ? 'sdk-store' : 'none' } }) + '\\n');
});
`,
    );
    await writeFile(join(f.home, "sdk-safe-status"), "logged-out");
    const registry = await openRegistry(join(f.home, "accounts.sqlite"));
    resources.own(() => registry.close());
    await registry.register(
      createInstance({
        id: "sdk-selected",
        provider: "cursor",
        label: "Selected SDK",
        homeDir: selectedHome,
      }),
    );
    registry.selectCursorSdk("sdk-selected");
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: f.home, ACE_PORT: "0" }, f.home),
      options: {
        providerStatus: { env: { PATH: f.home, HOME: f.home } },
        engine: {
          cursor: {
            instance: { id: "sdk-default", homeDir: join(f.home, "wrong-home") },
            env: { HOME: f.home },
            entry,
            discovery: {
              platform: "darwin",
              arch: "arm64",
              nodeVersion: "24.0.0",
              resolve: (id) =>
                id === "@cursor/sdk" ? join(sdkRoot, "index.js") : join(helper, "package.json"),
            },
          },
        },
      },
      signal: new AbortController().signal,
      services: { accountRegistry: registry },
      store: f.store,
      resources,
      now: () => 1000,
      id: () => "status",
      log,
      onListen: [],
    };
    startProviderStatuses(context);
    const statuses = context.services.providerStatuses;
    if (!statuses) throw new Error("Provider statuses unavailable");
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.send({ type: "providers.request", requestId: "out", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "cursor",
            runtime: "cursor-sdk",
            installed: true,
            version: "1.0.35",
            auth: "logged_out",
            authDetail: "none",
          }),
        ]),
      },
    });
    await writeFile(join(f.home, "sdk-safe-status"), "logged-in");
    client.send({ type: "providers.request", requestId: "in", operation: "refresh" });
    expect(await client.next()).toMatchObject({
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "cursor",
            runtime: "cursor-sdk",
            auth: "logged_in",
            authDetail: "sdk-store",
          }),
        ]),
      },
    });
    expect((await readFile(join(f.home, "sdk-calls"), "utf8")).trim().split("\n")).toEqual([
      `status:${join(selectedHome, "user")}`,
      `status:${join(selectedHome, "user")}`,
    ]);
  } finally {
    await server?.close();
    await resources.close();
    await log.close();
    await f.close();
  }
});
