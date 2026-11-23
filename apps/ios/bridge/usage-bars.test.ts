import "./test-host.ts";
import { expect, test } from "vitest";
import { followUsageBars } from "./usage-bars.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

test("the Usage glyph updates on a committed limit and skips identical bars", async () => {
  const { daemon, client } = sheetFixture();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const account = daemon.services.accounts.find(
    (entry) => entry.provider === "codex" && entry.label === "Personal",
  );
  if (!account) throw new Error("Missing Codex fixture");
  daemon.services.accounts = [account];
  const quota = (usedPercent: number) => ({
    ...account.quota,
    observedAt: now,
    windows: {
      five_hour: {
        usedPercent,
        resetsAt: now + 300_000,
        source: "cli" as const,
        windowDurationMins: 300,
      },
    },
  });
  daemon.services.updateQuota(account.id, quota(60));

  const sink = new RecordingSink();
  const stop = followUsageBars(client, sink, { now: () => now, set: () => () => {} });
  const bars = () => sink.read("usage.bars")?.value;
  try {
    await client.start();
    await until(() => bars() !== undefined, "initial bars");
    expect(bars()).toMatchObject([{ label: "Codex", left: 40, tone: "ok", span: "session" }]);

    daemon.services.updateQuota(account.id, quota(60));
    daemon.services.updateQuota(account.id, quota(95));
    await until(() => sink.puts >= 2, "updated bars");
    expect(bars()).toMatchObject([{ label: "Codex", left: 5, tone: "low" }]);
    expect(sink.puts).toBe(2);

    daemon.services.updateQuota(account.id, quota(100));
    await until(() => sink.puts >= 3, "spent bar");
    expect(bars()).toMatchObject([{ label: "Codex", left: 0, tone: "out" }]);
  } finally {
    stop();
    await client.close();
  }
});

test("the Usage glyph draws the accounts the person chose, in their order", async () => {
  const { daemon, client } = sheetFixture();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const readable = daemon.services.accounts
    .filter((entry) => entry.provider === "codex")
    .slice(0, 2);
  if (readable.length < 2) throw new Error("Missing Codex fixtures");
  daemon.services.accounts = readable;
  readable.forEach((account, index) =>
    daemon.services.updateQuota(account.id, {
      ...account.quota,
      observedAt: now,
      windows: {
        five_hour: {
          usedPercent: 20 + index * 40,
          resetsAt: now + 300_000,
          source: "cli" as const,
          windowDurationMins: 300,
        },
      },
    }),
  );
  const sink = new RecordingSink();
  const follow = followUsageBars(client, sink, { now: () => now, set: () => () => {} });
  const read = () =>
    sink.read("usage.bars") as {
      value: { left: number }[];
      choices: { id: string; shown: boolean }[];
    };
  try {
    await client.start();
    await until(() => read()?.value.length === 2, "both accounts");
    const [first, second] = readable.map((account) => account.id);
    expect(read().choices.map((choice) => choice.id)).toEqual([first, second]);

    follow.choose([second]);
    expect(read().value.map((bar) => bar.left)).toEqual([40]);
    expect(read().choices.map((choice) => [choice.id, choice.shown])).toEqual([
      [second, true],
      [first, false],
    ]);

    follow.choose([second, first]);
    expect(read().value.map((bar) => bar.left)).toEqual([40, 80]);

    follow.choose([]);
    expect(read().value).toHaveLength(2);
  } finally {
    follow();
    await client.close();
  }
});
