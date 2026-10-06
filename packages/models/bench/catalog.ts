import { performance } from "node:perf_hooks";
import { ProviderConfigurations } from "@ace/protocol";
import {
  ModelCatalog,
  ModelInstance,
  openModelStorage,
  normalizeCodex,
  normalizeClaude,
  normalizeOpenCodeV2,
} from "../src/index.ts";
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
let preferences: ProviderConfigurations = [
  {
    provider: "codex",
    hiddenModels: rows.map((row) => `hidden-${row.id}`),
    shownModels: rows.map((row) => row.id),
    favourites: rows.map((row) => row.id),
    hiddenGroups: rows.map((row) => `hidden-${row.id}`),
    shownGroups: rows.map((row) => `shown-${row.id}`),
    customModels: Array.from({ length: 128 }, (_, index) => ({
      id: `custom-${index}`,
      displayName: `Custom ${index}`,
    })),
  },
];
const catalog = new ModelCatalog({
  storage: openModelStorage(":memory:"),
  instances: [config],
  discover: async () => rows,
  now: () => 1000,
  deadline: () => () => {},
  preferences: () => preferences,
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
measure("cached dense preferences, one final native row", () =>
  catalog.list({ instance: "bench", limit: 1, offset: 511 }),
);
measure("cached dense preferences, final custom row", () =>
  catalog.list({ instance: "bench", limit: 1, offset: 639 }),
);
measure("changed dense preferences, one row", () => {
  preferences = ProviderConfigurations.parse(preferences);
  catalog.configurationChanged();
  return catalog.list({ instance: "bench", limit: 1 });
});
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

// Supported v2 metadata, without launching provider processes. Needs run at merge.
const opencodeConfig = ModelInstance.parse({ ...config, provider: "opencode" });
const v2 = {
  location: { directory: config.cwd },
  data: Array.from({ length: 512 }, (_, index) => ({
    id: `local/model-${index}`,
    providerID: "local",
    modelID: `model-${index}`,
    name: `Model ${index}`,
    enabled: true,
    status: "active",
    limit: { context: 200000, output: 8192 },
    capabilities: { input: { text: true, image: true } },
    variants: [{ id: "high" }],
    extension: "x".repeat(1024),
  })),
};
const parserIterations = 100;
for (let i = 0; i < 5; i++) normalizeOpenCodeV2(v2, opencodeConfig);
const start = performance.now();
for (let i = 0; i < parserIterations; i++) normalizeOpenCodeV2(v2, opencodeConfig);
const milliseconds = performance.now() - start;
console.log(
  JSON.stringify({
    name: "OpenCode v2 catalog, 512 models",
    iterations: parserIterations,
    bytesPerCatalog: Buffer.byteLength(JSON.stringify(v2)),
    opsPerSecond: Math.round((parserIterations * 1000) / milliseconds),
    microsecondsPerOp: (milliseconds * 1000) / parserIterations,
    modelsPerSecond: Math.round((parserIterations * 512 * 1000) / milliseconds),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);

// Dense canonical/alias ingestion and settings changes. Not executed; run at merge.
const claudeConfig = ModelInstance.parse({ ...config, provider: "claude" });
const claudeRows = normalizeClaude(
  {
    models: Array.from({ length: 256 }, (_, index) => [
      { value: `claude-opus-5-${index}`, displayName: `claude-opus-5-${index}` },
      { value: `opus-5.${index}`, displayName: `opus-5.${index}` },
    ]).flat(),
  },
  claudeConfig,
);
const claudeCatalog = new ModelCatalog({
  instances: [claudeConfig],
  storage: { load: () => [], replace() {}, remove() {}, close() {} },
  discover: async () => claudeRows,
  now: () => 1000,
  deadline: () => () => {},
});
await claudeCatalog.refresh();
for (let i = 0; i < 5; i++) await claudeCatalog.refresh();
const refreshStart = performance.now();
for (let i = 0; i < parserIterations; i++) await claudeCatalog.refresh();
console.log(
  JSON.stringify({
    name: "512 Claude selectors, canonical catalog refresh",
    selectors: claudeRows.length,
    iterations: parserIterations,
    microsecondsPerOp: ((performance.now() - refreshStart) * 1000) / parserIterations,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
measure("512 Claude selectors, warm canonical page", () => claudeCatalog.list({ limit: 100 }));
measure("256 canonical Claude models, changed settings generation", () => {
  claudeCatalog.configurationChanged();
  return claudeCatalog.list({ limit: 1 });
});
await claudeCatalog.close();
