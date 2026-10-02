import { performance } from "node:perf_hooks";
import { ModelCatalog, ModelInstance, openModelStorage, normalizeCodex } from "../src/index.ts";
const config = ModelInstance.parse({
  id: "bench",
  provider: "codex",
  loginRevision: "1",
  executable: "codex",
  cwd: process.cwd(),
});
const native = {
  data: Array.from({ length: 512 }, (_, index) => ({
    id: `id-${index}`,
    model: `model-${index}`,
    displayName: `Model ${index}`,
    isDefault: index === 0,
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "priority", name: "Fast" }],
    inputModalities: ["text", "image"],
  })),
};
const rows = normalizeCodex(native, config);
const catalog = new ModelCatalog({
  storage: openModelStorage(":memory:"),
  instances: [config],
  discover: async () => rows,
  now: () => 1000,
  deadline: () => () => {},
});
await catalog.refresh();
const iterations = 100_000;
function measure(name: string, operation: () => unknown) {
  for (let i = 0; i < 1000; i++) operation();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) operation();
  const milliseconds = performance.now() - start;
  console.log(
    JSON.stringify({
      name,
      models: rows.length,
      iterations,
      opsPerSecond: Math.round((iterations * 1000) / milliseconds),
      microsecondsPerOp: (milliseconds * 1000) / iterations,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}
measure("cached instance page, 100 rows", () => catalog.list({ instance: "bench", limit: 100 }));
measure("strongest compatible fast policy", () =>
  catalog.resolve({
    instance: "bench",
    role: "coder",
    selection: "strongest",
    preferenceOrder: ["model-511", "model-0"],
    tier: "fast",
    effort: "high",
  }),
);
await catalog.close();
