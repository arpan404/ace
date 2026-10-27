import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport, type UsageSource } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { readUsageReport } from "./usage-report.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/*
 * The Usage screen's Cost and Tokens views over the real SDK and an in-process fake daemon: the
 * web page's figures reach the phone as compact words, with growth against the period before.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-usage-report-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

const source = (
  provider: string,
  model: string,
  daily: number,
  price: number | null,
): UsageSource => ({
  provider,
  account: `${provider}-personal`,
  model,
  daily,
  steady: true,
  apiUsdPerMillion: price,
  billing: "subscription",
  threads: [`thread-${provider}`],
});

/** A machine whose usage doubled this week: the week before ran at half the tokens. */
function doubledWeek(): FakeDaemon {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
  });
  const usage = daemon.services.usage;
  const answer = usage.report.bind(usage);
  const thisWeek = Date.now() - 7 * 86_400_000;
  usage.report = (query, kind) => {
    const scale = Date.parse(query.from) >= thisWeek ? 2 : 1;
    usage.sources = [
      source("codex", "gpt-5.3-codex", 400_000_000 * scale, 5),
      source("claude", "claude-unlisted-model", 100_000_000 * scale, null),
    ];
    return answer(query, kind);
  };
  return daemon;
}

test("tokens read in compact units, with growth against the week before", async () => {
  const owner = await connect(doubledWeek());
  const reply = await readUsageReport(
    owner,
    { type: "usage.report", days: 7 },
    new AbortController().signal,
  );
  // (400M + 100M input) × 2, plus a quarter as output, every day for seven days.
  expect(reply.tokens.total).toBe("8.8B");
  expect(reply.tokens.growth).toEqual({ direction: "up", label: "+100%" });
  expect(reply.tokens.basis).toBe("vs previous 7 days");
  expect(reply.tokens.providers.map((line) => [line.name, line.figure, line.growth.label])).toEqual(
    [
      ["Codex", "7B", "+100%"],
      ["Claude Code", "1.8B", "+100%"],
    ],
  );
  expect(reply.tokens.chart.days).toHaveLength(7);
  expect(reply.tokens.chart.days[0]?.texts).toEqual(["1B", "250M"]);
  expect(reply.tokens.chart.axis.map((tick) => tick.label)).toEqual(["0", "500M", "1B"]);
  expect(reply.tokens.totals).toContainEqual({ label: "Unpriced tokens", value: "1.8B" });
  expect(reply.providers.map((entry) => entry.name).toSorted()).toEqual(["Claude Code", "Codex"]);
});

test("cost leaves a model ace has no price for out of the money and folds it into one line", async () => {
  const owner = await connect(doubledWeek());
  const reply = await readUsageReport(
    owner,
    { type: "usage.report", days: 7 },
    new AbortController().signal,
  );
  expect(reply.cost.total).toMatch(/^\$[\d,]+$/);
  expect(reply.cost.note).toMatch(/^API estimate/);
  expect(reply.cost.byModel.map((line) => line.provider)).toEqual(["codex"]);
  expect(reply.cost.byModel[0]).toMatchObject({ share: "100.0%", other: "7B tokens", fraction: 1 });
  expect(reply.cost.unpriced?.label).toBe("1 unpriced model · 1.8B tokens");
  expect(reply.cost.unpriced?.lines[0]?.figure).toBe("Unpriced");
  expect(reply.cost.providers.find((line) => line.id === "claude")?.figure).toBe("Unpriced");
});

test("one provider's report leaves the other out but still lists both for the filter", async () => {
  const owner = await connect(doubledWeek());
  const reply = await readUsageReport(
    owner,
    { type: "usage.report", days: 1, provider: "claude" },
    new AbortController().signal,
  );
  expect(reply.tokens.total).toBe("250M");
  expect(reply.tokens.basis).toBe("vs yesterday");
  expect(reply.tokens.providers.map((line) => line.id)).toEqual(["claude"]);
  expect(reply.providers.map((entry) => entry.id).toSorted()).toEqual(["claude", "codex"]);
});

test("the report arrives through the native service bridge, and a refusing machine fails it", async () => {
  const sink = new RecordingSink();
  new NativeServices(await connect(doubledWeek()), sink).handle({
    type: "service",
    id: "report",
    request: { type: "usage.report", days: 30 },
  });
  await until(() => sink.read("service:report"));
  expect(sink.read("service:report")).toMatchObject({
    ok: true,
    value: { type: "usage.report", tokens: { basis: "vs previous 30 days" } },
  });
  await client?.close();
  const refusing = doubledWeek();
  refusing.failRequests("usage.series");
  const failed = new RecordingSink();
  new NativeServices(await connect(refusing), failed).handle({
    type: "service",
    id: "report",
    request: { type: "usage.report", days: 7 },
  });
  await until(() => failed.read("service:report"));
  expect(failed.read("service:report")).toMatchObject({ ok: false, value: null });
});
