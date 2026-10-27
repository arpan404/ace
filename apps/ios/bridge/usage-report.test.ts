import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport, type UsageSource } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { readUsagePart, type UsagePartRequest } from "./usage-part.ts";
import { combineUsage } from "./usage-report.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/*
 * The Usage screen's Cost and Tokens views over the real SDK and an in-process fake daemon: the
 * web page's figures reach the phone as compact words, with growth against the period before.
 */

const clients: ClientCore[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((owner) => owner.close()));
});

async function connect(daemon: FakeDaemon, host = "ios-test-host"): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-usage-report-test"),
    expectedHostId: HostId.parse(host),
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
  clients.push(owner);
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
function doubledWeek(host = "ios-test-host", share = 1): FakeDaemon {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: host,
    token: "ios-test-token",
  });
  const usage = daemon.services.usage;
  const answer = usage.report.bind(usage);
  const thisWeek = Date.now() - 7 * 86_400_000;
  usage.report = (query, kind) => {
    const scale = (Date.parse(query.from) >= thisWeek ? 2 : 1) * share;
    usage.sources = [
      source("codex", "gpt-5.3-codex", 400_000_000 * scale, 5),
      source("claude", "claude-unlisted-model", 100_000_000 * scale, null),
    ];
    return answer(query, kind);
  };
  return daemon;
}

const signal = () => new AbortController().signal;

/** One machine's Cost and Tokens views, as the phone combines a single part. */
async function report(owner: ClientCore, request: Omit<UsagePartRequest, "type">) {
  const part = await readUsagePart(owner, { type: "usage.part", ...request }, signal());
  return combineUsage({
    type: "usage.combine",
    days: request.days,
    machines: [{ id: "mac", name: "Mac", reach: "counted", part }],
  });
}

test("tokens read in compact units, with growth against the week before", async () => {
  const owner = await connect(doubledWeek());
  const reply = await report(owner, { days: 7 });
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
  expect(reply.tokens.chart.top).toBe(1_000_000_000);
  expect(reply.tokens.totals).toContainEqual({ label: "Unpriced tokens", value: "1.8B" });
  expect(reply.providers.map((entry) => entry.name).toSorted()).toEqual(["Claude Code", "Codex"]);
});

test("cost leaves a model ace has no price for out of the money and folds it into one line", async () => {
  const owner = await connect(doubledWeek());
  const reply = await report(owner, { days: 7 });
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
  const reply = await report(owner, { days: 1, provider: "claude" });
  expect(reply.tokens.total).toBe("250M");
  expect(reply.tokens.basis).toBe("vs yesterday");
  expect(reply.tokens.providers.map((line) => line.id)).toEqual(["claude"]);
  expect(reply.providers.map((entry) => entry.id).toSorted()).toEqual(["claude", "codex"]);
});

test("two machines' usage sums per day, with growth over both machines' week before", async () => {
  // The second machine runs at half the first's tokens; both doubled this week.
  const mac = await connect(doubledWeek("ios-mac"), "ios-mac");
  const studio = await connect(doubledWeek("ios-studio", 0.5), "ios-studio");
  const lead = await readUsagePart(mac, { type: "usage.part", days: 7 }, signal());
  const other = await readUsagePart(
    studio,
    { type: "usage.part", days: 7, from: lead.from, to: lead.to },
    signal(),
  );
  const reply = combineUsage({
    type: "usage.combine",
    days: 7,
    machines: [
      { id: "mac", name: "Mac", reach: "counted", part: lead },
      { id: "studio", name: "Studio", reach: "counted", part: other },
    ],
  });
  // 8.75B on the first machine and half that on the second.
  expect(reply.tokens.total).toBe("13.1B");
  expect(reply.tokens.growth).toEqual({ direction: "up", label: "+100%" });
  expect(reply.tokens.chart.days[0]?.texts).toEqual(["1.5B", "375M"]);
  expect(reply.coverage).toEqual({ line: "All 2 machines", complete: true });
});

test("an offline machine is named beside the totals, which count only the machines read", async () => {
  const part = await readUsagePart(
    await connect(doubledWeek()),
    { type: "usage.part", days: 7 },
    signal(),
  );
  const reply = combineUsage({
    type: "usage.combine",
    days: 7,
    machines: [
      { id: "mac", name: "Mac", reach: "counted", part },
      { id: "studio", name: "Studio", reach: "offline" },
    ],
  });
  expect(reply.tokens.total).toBe("8.8B");
  expect(reply.coverage).toEqual({ line: "1 of 2 machines · Studio is offline", complete: false });
});

test("a part kept from other days waits as loading instead of skewing the sums", async () => {
  const owner = await connect(doubledWeek());
  const today = await readUsagePart(owner, { type: "usage.part", days: 7 }, signal());
  const older = { ...today, from: "2020-01-01", to: "2020-01-07" };
  const reply = combineUsage({
    type: "usage.combine",
    days: 7,
    machines: [
      { id: "mac", name: "Mac", reach: "counted", part: today },
      { id: "studio", name: "Studio", reach: "counted", part: older },
    ],
  });
  expect(reply.tokens.total).toBe("8.8B");
  expect(reply.coverage.line).toBe("1 of 2 machines · Studio is still loading");
});

test("the part arrives through the native service bridge, and a refusing machine fails it", async () => {
  const sink = new RecordingSink();
  new NativeServices(await connect(doubledWeek()), sink).handle({
    type: "service",
    id: "part",
    request: { type: "usage.part", days: 30 },
  });
  await until(() => sink.read("service:part"));
  expect(sink.read("service:part")).toMatchObject({ ok: true, value: { type: "usage.part" } });
  const refusing = doubledWeek("ios-refusing");
  refusing.failRequests("usage.series");
  const failed = new RecordingSink();
  new NativeServices(await connect(refusing, "ios-refusing"), failed).handle({
    type: "service",
    id: "part",
    request: { type: "usage.part", days: 7 },
  });
  await until(() => failed.read("service:part"));
  expect(failed.read("service:part")).toMatchObject({ ok: false, value: null });
});
