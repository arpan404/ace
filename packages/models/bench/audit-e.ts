/** Merge-time benchmark only. Development execution is prohibited by the owner's rule. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  ModelCatalog,
  ModelInstance,
  normalizeAcp,
  normalizeCodex,
  openModelStorage,
} from "../src/index.ts";

const configurations = Array.from({ length: 64 }, (_, index) =>
  ModelInstance.parse({
    id: `account-${index}`,
    provider: "codex",
    loginRevision: "1",
    executable: "unused",
    cwd: process.cwd(),
  }),
);
const native = {
  data: Array.from({ length: 512 }, (_, index) => ({
    id: `id-${index}`,
    model: `model-${index}`,
    displayName: `Model ${index}`,
    isDefault: index === 0,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    defaultReasoningEffort: "high",
  })),
};
const byInstance = new Map(
  configurations.map((config) => [config.id, normalizeCodex(native, config)]),
);

function report(operation: string, iterations: number, elapsedMs: number) {
  console.log(
    JSON.stringify({
      operation,
      iterations,
      operationsPerSecond: Math.round((iterations * 1000) / elapsedMs),
      microsecondsPerOperation: (elapsedMs * 1000) / iterations,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}

const work = await mkdtemp(join(tmpdir(), "ace-models-audit-e-bench-"));
try {
  const path = join(work, "models.sqlite");
  const storage = openModelStorage(path);
  try {
    const catalog = new ModelCatalog({
      storage,
      instances: configurations,
      discover: async (config) => {
        const rows = byInstance.get(config.id);
        if (!rows) throw new Error("Unknown benchmark instance");
        return rows;
      },
      now: () => 1000,
      deadline: () => () => {},
    });
    try {
      await catalog.refresh();
      const db = new DatabaseSync(path);
      try {
        db.exec(
          "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog WHEN OLD.instance='account-0' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
        );
        const removed = await catalog.removeInstance("account-0").then(
          () => true,
          () => false,
        );
        if (removed) throw new Error("Benchmark removal must fail");
        const refresh = async () => {
          const statuses = await catalog.refresh({ instance: "account-1" });
          if (statuses[0]?.error) throw new Error("Healthy benchmark refresh failed");
        };
        for (let index = 0; index < 10; index++) await refresh();
        const iterations = 100;
        const started = performance.now();
        for (let index = 0; index < iterations; index++) await refresh();
        report(
          "healthy refresh with failed unrelated deletion, 64 rows and 512 models per row",
          iterations,
          performance.now() - started,
        );
      } finally {
        try {
          db.exec("DROP TRIGGER IF EXISTS reject_delete");
        } finally {
          db.close();
        }
      }
    } finally {
      await catalog.close();
    }
  } finally {
    await storage.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

const acp = ModelInstance.parse({
  id: "acp",
  provider: "acp",
  loginRevision: "1",
  executable: "unused",
  cwd: process.cwd(),
});
const extensions = Array.from({ length: 63 }, (_, index) => ({
  id: `future-${index}`,
  type: "boolean",
  currentValue: true,
  description: "x".repeat(128),
  apiKey: "redact-me",
}));
for (const currentValue of ["model-511", "absent"]) {
  const payload = {
    configOptions: [
      {
        id: "model",
        type: "select",
        currentValue,
        options: native.data.map((model) => ({
          value: model.model,
          name: model.displayName,
          configOptions: [],
        })),
      },
      ...extensions,
    ],
  };
  for (let index = 0; index < 10; index++) normalizeAcp(payload, acp);
  const iterations = 100;
  const started = performance.now();
  for (let index = 0; index < iterations; index++) normalizeAcp(payload, acp);
  report(
    `ACP with 63 extensions and empty per-model configs, 512 models, current=${currentValue}`,
    iterations,
    performance.now() - started,
  );
}
