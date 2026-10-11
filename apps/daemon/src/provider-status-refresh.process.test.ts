import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ProviderStatus } from "@ace/protocol";
import { ProviderStatuses } from "./provider-status.ts";
import { fakeCli } from "./provider-status-test-support.ts";
import { fixture } from "./socket-test-support.ts";

test("automatic auth and installation changes reach subscribed clients with settled status", async () => {
  const home = await fixture();
  const bin = join(home.home, "bin");
  await mkdir(bin);
  await fakeCli(bin, "codex", "codex-cli 0.159.1", "Not logged in", "login status");
  let now = 100;
  let expire: (() => void) | undefined;
  const statuses = new ProviderStatuses(
    { env: { HOME: home.home, PATH: bin } },
    {
      now: () => now,
      schedule(callback) {
        expire = callback;
        return () => {
          expire = undefined;
        };
      },
    },
  );
  let server: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await statuses.refresh();
    server = await fixture({ providerStatuses: statuses });
    const client = await server.connect();
    await client.next();
    client.receiveCatalogPushes = true;
    const notices: ProviderStatus[][] = [];
    statuses.listen((rows) => notices.push(rows));
    for (const state of ["logged_in", "logged_out", "removed"] as const) {
      if (state === "removed") await rm(join(bin, "codex"));
      else
        await writeFile(
          join(bin, "codex-auth"),
          state === "logged_in" ? "Logged in using ChatGPT" : "Not logged in",
        );
      now += 300_000;
      expire?.();
      await statuses.refresh();
      expect(notices.at(-1)?.find((row) => row.provider === "codex")).toMatchObject({
        auth: state === "removed" ? "unknown" : state,
        installed: state !== "removed",
        refreshing: false,
        stale: false,
        checkedAt: now,
      });
      const pushed = await client.next();
      expect(pushed.type).toBe("providers.changed");
      if (pushed.type !== "providers.changed") throw new Error("Missing provider push");
      expect(pushed.providers.find((row) => row.provider === "codex")).toMatchObject({
        auth: state === "removed" ? "unknown" : state,
        installed: state !== "removed",
        refreshing: false,
        stale: false,
        checkedAt: now,
      });
    }
    const count = notices.length;
    now += 300_000;
    expire?.();
    await statuses.refresh();
    statuses.publish();
    expect(notices).toHaveLength(count);
  } finally {
    await statuses.close();
    await server?.close();
    await home.close();
  }
});

test("closing discovery cannot publish a late authentication result", async () => {
  const home = await fixture();
  const bin = join(home.home, "bin");
  await mkdir(bin);
  await fakeCli(bin, "codex", "codex-cli 0.159.1", "Not logged in", "login status");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const statuses = new ProviderStatuses(
    {
      env: { HOME: home.home, PATH: bin },
      probe: async () => {
        entered.resolve();
        await release.promise;
        return { code: 0, stdout: "codex-cli 0.159.1", stderr: "" };
      },
    },
    { now: () => 100, schedule: () => () => {} },
  );
  const notices: ProviderStatus[][] = [];
  statuses.listen((rows) => notices.push(rows));
  try {
    await entered.promise;
    const closed = statuses.close();
    release.resolve();
    await closed;
    expect(notices).toEqual([]);
  } finally {
    release.resolve();
    await statuses.close();
    await home.close();
  }
});
