import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { UsageStore, UsageEvent } from "./index.ts";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).toReversed()) close();
});
export const query = { from: "2026-01-01", to: "2026-12-31" };
export function setup(settings: unknown = {}) {
  const home = mkdtempSync(join(tmpdir(), "ace-usage-"));
  let store = new UsageStore(join(home, "usage.sqlite"), settings);
  cleanups.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  let seq = store.cursor();
  const send = (
    payload: UsageEvent["payload"],
    at = Date.parse("2026-10-02T12:00Z"),
    threadId = "thread",
  ) => {
    const event = UsageEvent.parse({ seq: ++seq, at, threadId, payload });
    store.ingest({ afterSeq: seq - 1, throughSeq: seq, events: [event] });
    return event;
  };
  const thread = (id = "thread", provider = "codex", workspace = "workspace") =>
    send({ type: "thread.created", provider, workspace }, undefined, id);
  const agent = (
    id = "root",
    parent: string | null = null,
    model: string | null = "claude-sonnet-4-6",
    provider = "codex",
    threadId = "thread",
  ) => send({ type: "agent.created", id, parent, model, provider }, undefined, threadId);
  return {
    home,
    get store() {
      return store;
    },
    send,
    thread,
    agent,
    reopen(nextSettings: unknown = settings) {
      store.close();
      store = new UsageStore(join(home, "usage.sqlite"), nextSettings);
      seq = store.cursor();
    },
    usage(
      inputTokens: number,
      agentId = "root",
      extra: Partial<Extract<UsageEvent["payload"], { type: "usage.updated" }>> = {},
      at?: number,
    ) {
      return send({ type: "usage.updated", agentId, inputTokens, outputTokens: 0, ...extra }, at);
    },
    totals(input: unknown = query) {
      const row = store.summary(input).rows[0];
      if (!row) throw new Error("Expected total row");
      return row.totals;
    },
  };
}
