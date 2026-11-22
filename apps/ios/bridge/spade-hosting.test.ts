import { expect, test } from "vitest";
import type { FakeSpadeApi } from "@ace/fake-daemon";
import { until } from "./test-host.ts";
import { setUp } from "./spade-test-host.ts";

/*
 * What one machine's runtime tells Swift for the Spade tab's list across machines: where the
 * fleet chose Spade lives (`GET /v1/main`), the machine's host id, each row's facts for the
 * merge, and its bots as away while the machine is out of reach.
 */

test("a machine's answer about where Spade lives reaches Swift, with the machine's host id", async () => {
  const { patches, spade } = await setUp((api) => {
    api.here = "ios-test-host";
    api.hostRecord = { host: "studio", version: 2, at: 5, by: "person" };
    api.addAgent({ name: "Research" });
  });
  spade.handle({ type: "spade.watch", on: true });

  const main = await until(() => patches.state?.main ?? undefined);

  expect(main).toEqual({ record: { host: "studio", version: 2, at: 5, by: "person" } });
  await until(() => patches.state?.host === "ios-test-host");
});

test("a machine holding no host choice says so, and a refresh reads the choice again", async () => {
  let api = undefined as FakeSpadeApi | undefined;
  const { patches, spade } = await setUp((fake) => {
    api = fake;
  });
  if (!api) throw new Error("no api");
  spade.handle({ type: "spade.watch", on: true });
  await until(() => patches.state?.main?.record === null);

  api.hostRecord = { host: "ios-test-host", version: 1, at: 9, by: "seed" };
  spade.handle({ type: "spade.refresh" });

  await until(() => patches.state?.main?.record?.host === "ios-test-host");
});

test("each row carries what the merged list orders and elects by", async () => {
  const { patches, spade } = await setUp((api) => {
    api.addAgent({ name: "Spade", kind: "main", last_activity: 7, created_at: 3 });
    api.addAgent({ name: "Busy", state: "working", status: "Reading", last_activity: 30 });
  });
  spade.handle({ type: "spade.watch", on: true });

  const rows = await until(() =>
    patches.state?.list.rows?.length === 2 ? patches.state.list.rows : undefined,
  );

  const busy = rows.find((row) => row.name === "Busy");
  const main = rows.find((row) => row.main);
  expect(busy?.at).toBe(30);
  expect(main?.at).toBe(7);
  expect(main?.createdAt).toBe(3);
  // Working sorts above the rest; Swift orders the merged list by this rank, then by `at`.
  expect(busy?.rank).toBeLessThan(main?.rank ?? 0);
});

test("a machine that drops keeps its bots listed as away, never still working, and restores them", async () => {
  const { daemon, patches, spade } = await setUp((api) =>
    api.addAgent({ name: "Busy", state: "working", status: "Reading" }),
  );
  spade.handle({ type: "spade.watch", on: true });
  const busy = () => patches.state?.list.rows?.find((row) => row.name === "Busy");
  await until(() => busy()?.state === "working");

  daemon.refuseConnections(true);

  await until(() => busy()?.state === "off");
  expect(busy()?.line).toMatch(/is offline$/);
  expect(busy()?.faces[0]?.away).toBe(true);

  daemon.refuseConnections(false);

  // The socket comes back on its own backoff, which can outlast `until`'s two seconds.
  for (let waited = 0; busy()?.state !== "working" && waited < 15_000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(busy()?.state).toBe("working");
}, 20_000);

test("after a reconnect a machine's last rows stay unconfirmed until its bots read again, never Working", async () => {
  let bot = undefined as ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  const { api, daemon, patches, spade } = await setUp((fake) => {
    bot = fake.addAgent({ name: "Busy", state: "working", status: "Reading" });
  });
  if (!bot) throw new Error("no bot");
  spade.handle({ type: "spade.watch", on: true });
  const busy = () => patches.state?.list.rows?.find((row) => row.name === "Busy");
  await until(() => busy()?.state === "working");
  daemon.refuseConnections(true);
  await until(() => busy()?.state === "off");

  // It finishes while the machine is away, and once back its Spade won't list the bots.
  api.status(bot, "idle", null);
  let refused = 0;
  daemon.spade.serve({
    answer: (request) => {
      if (request.path !== "/v1/agents") return api.answer(request);
      refused++;
      return { status: 500, body: "{}" };
    },
    open: (path) => api.open(path),
  });
  const seen: string[] = [];
  const put = patches.put.bind(patches);
  patches.put = (key, read) => {
    put(key, read);
    const row = busy();
    if (row) seen.push(`${row.state}: ${row.line}`);
  };
  daemon.refuseConnections(false);

  const tries = () => refused;
  for (let waited = 0; tries() < 2 && waited < 15_000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(refused).toBeGreaterThanOrEqual(2);
  expect(seen.filter((line) => !line.startsWith("off: "))).toEqual([]);
  expect(busy()?.line).toMatch(/^Couldn't confirm/);

  // A read that lands on the new connection shows the bot as it is now.
  daemon.spade.serve(api);
  spade.handle({ type: "spade.refresh" });
  await until(() => busy()?.state === "rest");
}, 25_000);
