import { apply, createThreadState, FactBatch, nextDeadline, type Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";

// Public core facts, measuring record work rather than host-dependent elapsed time.
const seen = (agent: string, parent?: string): Fact => ({
  type: "agent.seen",
  agent,
  ...(parent ? { parent } : {}),
  origin: parent ? "provider_subagent" : "root",
  fidelity: "full",
  native: { provider: "codex", nativeId: agent },
  cwd: "/repo",
  background: false,
});
const measurements = [];
for (const children of [1, 128, 1_000]) {
  let sequence = 0;
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const state = createThreadState({
    threadId: ThreadId.parse("history"),
    config: { provider: "codex", silenceMs: 90_000 },
  });
  const send = (fact: Fact) => apply(state, fact, { now: 100, ids });
  send(seen("root"));
  send({ type: "turn.started", agent: "root", nativeTurnId: "root-run", trigger: "user" });
  for (let index = 0; index < children; index++) {
    const agent = `child-${index}`;
    send(seen(agent, "root"));
    send({ type: "turn.started", agent, nativeTurnId: agent, trigger: "spawn" });
    send({ type: "turn.ended", agent, outcome: "completed" });
  }
  send({
    type: "item.upsert",
    agent: "root",
    item: "answer",
    draft: { type: "message", role: "assistant", parts: [], complete: false },
  });
  send({ type: "item.delta", agent: "root", item: "answer", field: "text", append: "Seed" });
  const deadline = nextDeadline(state);
  let reads = 0,
    enumerations = 0;
  state.agents = new Proxy(state.agents, {
    get(target, key, receiver) {
      if (typeof key === "string") reads++;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const batch = new FactBatch(state, { deadline });
  const ctx = { now: 101, ids };
  batch.apply({ type: "signal", agent: "root" }, ctx);
  batch.apply(
    { type: "item.delta", agent: "root", item: "answer", field: "text", append: "Hello" },
    ctx,
  );
  batch.flush();
  if (
    state.status.state !== "working" ||
    state.items.answer?.type !== "message" ||
    state.items.answer.parts.some((part) => part.type === "text" && part.text === "SeedHello") !==
      true
  )
    throw new Error("Stream changed status or lost its append");
  measurements.push({ children, reads, enumerations });
}
process.stdout.write(JSON.stringify(measurements, null, 2) + "\n");
if (measurements.some((sample) => sample.reads > 32 || sample.enumerations > 0))
  throw new Error("Ordinary streaming work grew with historical agents");
