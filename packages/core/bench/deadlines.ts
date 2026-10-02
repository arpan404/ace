import { ThreadId } from "@ace/protocol";
import { apply, createThreadState, nextDeadline } from "../src/index.ts";

// Non-gating timings plus deterministic work counts for the public scheduler API.
for (const count of [20, 40, 80, 160]) {
  let sequence = 0;
  const state = createThreadState({
    threadId: ThreadId.parse("benchmark"),
    config: { provider: "codex", silenceMs: 10 },
  });
  const ctx = { now: 100, ids: { next: (kind: string) => `${kind}-${++sequence}` } };
  apply(state, { type: "turn.started", agent: "root", trigger: "user" }, ctx);
  for (let index = 0; index < count; index++) {
    const agent = `child-${index}`;
    apply(state, { type: "turn.started", agent, trigger: "spawn" }, ctx);
    apply(
      state,
      { type: "item.delta", agent, item: `shell-${index}`, field: "output", append: "." },
      ctx,
    );
  }
  let reads = 0;
  state.items = new Proxy(state.items, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(target, key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const started = performance.now();
  for (let pass = 0; pass < 100; pass++) nextDeadline(state);
  console.log(
    JSON.stringify({
      shells: count,
      passes: 100,
      itemReadsPerPass: reads / 100,
      ms: +(performance.now() - started).toFixed(2),
    }),
  );
}
