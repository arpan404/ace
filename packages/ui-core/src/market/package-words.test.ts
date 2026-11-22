import { expect, test } from "vitest";
import { effectDefaults, limitSentences, triggerWhen } from "./index.ts";

/* An agent package's review in plain sentences, shared by the web and the phone. */

const bot = (extra: Record<string, unknown>) =>
  ({ type: "spade-bot", botName: "Inbox", model: "fast", routines: [], ...extra }) as never;

test("a package's components start on, each under its own code switch", () => {
  expect(effectDefaults(bot({ code: [{ name: "fares" }] }), false)).toEqual({ "code:fares": true });
});

test("what a package expects to spend and use reads as its facts", () => {
  expect(
    limitSentences(
      bot({
        limits: { spend_alert: { usd_per_day: 0.5 }, workers_at_once: 1, workspace_mb: 40 },
        triggers: [{ kind: "mention" }],
      }),
    ),
  ).toEqual([
    "Expected to cost about $0.50 a day on your fast model.",
    "Runs one of its workers at a time.",
    "Expects its files to reach about 40 MB.",
    "Can be @-mentioned from your threads and clubs.",
  ]);
});

test("an event trigger reads as when it runs; a message trigger has no second line", () => {
  expect(triggerWhen({ kind: "event", event: "thread.failed" } as never)).toBe(
    "When an agent thread fails",
  );
  expect(triggerWhen({ kind: "message" } as never)).toBeUndefined();
});
