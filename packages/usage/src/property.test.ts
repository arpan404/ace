import { expect, it } from "vitest";
import * as fc from "fast-check";
import { UsageStore, UsageEvent } from "./index.ts";

it("daily rollups equal raw consumption in randomized interleaved provider streams and retries", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          agent: fc.integer({ min: 0, max: 2 }),
          day: fc.integer({ min: 1, max: 28 }),
          input: fc.integer({ min: 1, max: 10000 }),
          output: fc.integer({ min: 0, max: 5000 }),
          cached: fc.integer({ min: 0, max: 10000 }),
          reasoning: fc.integer({ min: 0, max: 5000 }),
          cost: fc.integer({ min: 0, max: 10 }),
          cumulative: fc.boolean(),
          subscription: fc.boolean(),
          scope: fc.integer({ min: 0, max: 3 }),
          resends: fc.integer({ min: 0, max: 2 }),
        }),
        { minLength: 1, maxLength: 160 },
      ),
      (samples) => {
        const store = new UsageStore(":memory:");
        try {
          let seq = 0;
          const send = (payload: UsageEvent["payload"], day = 1) => {
            const event = UsageEvent.parse({
              seq: ++seq,
              at: Date.parse(`2026-10-${String(day).padStart(2, "0")}T12:00Z`),
              threadId: "t",
              payload,
            });
            const batch = { afterSeq: seq - 1, throughSeq: seq, events: [event] };
            store.ingest(batch);
            store.ingest(batch);
          };
          send({ type: "thread.created", workspace: "w", provider: "codex" });
          for (let a = 0; a < 3; a++)
            send({
              type: "agent.created",
              id: `a${a}`,
              parent: a === 0 ? null : "a0",
              provider: "codex",
              model: null,
            });
          // The oracle books raw consumption. A separate emitter turns those facts
          // into provider counters and duplicates; it does not determine expected totals.
          const daily = new Map<
            string,
            { input: number; output: number; cached: number; reasoning: number; cost: number }
          >();
          const emitted = new Map<
            string,
            { input: number; output: number; cached: number; reasoning: number; cost: number }
          >();
          let totalInput = 0,
            totalOutput = 0,
            totalCached = 0,
            totalReasoning = 0,
            totalCost = 0;
          for (const [index, sample] of samples.entries()) {
            const consumption = {
              input: sample.input,
              output: sample.output,
              cached: Math.min(sample.cached, sample.input),
              reasoning: Math.min(sample.reasoning, sample.output),
              cost: sample.cost,
            };
            const day = `2026-10-${String(sample.day).padStart(2, "0")}`;
            const prior = daily.get(day) ?? {
              input: 0,
              output: 0,
              cached: 0,
              reasoning: 0,
              cost: 0,
            };
            daily.set(day, {
              input: prior.input + consumption.input,
              output: prior.output + consumption.output,
              cached: prior.cached + consumption.cached,
              reasoning: prior.reasoning + consumption.reasoning,
              cost: prior.cost + (sample.subscription ? 0 : consumption.cost),
            });
            totalInput += consumption.input;
            totalOutput += consumption.output;
            totalCached += consumption.cached;
            totalReasoning += consumption.reasoning;
            totalCost += sample.subscription ? 0 : consumption.cost;
            let report = consumption;
            const scope = sample.cumulative ? `s${sample.scope}` : `sample${index}`;
            if (sample.cumulative) {
              const key = `${sample.agent}/${scope}`;
              const old = emitted.get(key) ?? {
                input: 0,
                output: 0,
                cached: 0,
                reasoning: 0,
                cost: 0,
              };
              report = {
                input: old.input + consumption.input,
                output: old.output + consumption.output,
                cached: old.cached + consumption.cached,
                reasoning: old.reasoning + consumption.reasoning,
                cost: old.cost + consumption.cost,
              };
              emitted.set(key, report);
            }
            for (let repeat = 0; repeat <= sample.resends; repeat++)
              send(
                {
                  type: "usage.updated",
                  agentId: `a${sample.agent}`,
                  inputTokens: report.input,
                  outputTokens: report.output,
                  cachedInputTokens: report.cached,
                  reasoningTokens: report.reasoning,
                  costUsd: report.cost,
                  billingMode: sample.subscription ? "subscription" : "unknown",
                  counterMode: sample.cumulative ? "cumulative" : "incremental",
                  counterKey: scope,
                },
                sample.day,
              );
          }
          const q = { from: "2026-10-01", to: "2026-10-31", limit: 1000 };
          expect(store.summary({ ...q, agentTree: "a0" }).rows[0]?.totals).toMatchObject({
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cachedInputTokens: totalCached,
            reasoningTokens: totalReasoning,
            providerReportedUsd: totalCost,
          });
          expect(
            store
              .series(q)
              .rows.map((r) => [
                r.dimensions.day,
                r.totals.inputTokens,
                r.totals.outputTokens,
                r.totals.cachedInputTokens,
                r.totals.reasoningTokens,
                r.totals.providerReportedUsd,
              ]),
          ).toEqual(
            [...daily.entries()]
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([day, v]) => [day, v.input, v.output, v.cached, v.reasoning, v.cost]),
          );
        } finally {
          store.close();
        }
      },
    ),
    { numRuns: 100, seed: 4040 },
  );
});
