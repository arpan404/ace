import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { spawnSupervised } from "@ace/provider-kit/process";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { startModels } from "./services/models.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import { Store } from "./store.ts";
import type { ServiceContext } from "./services/types.ts";

const record = z.object({
  message: z.string(),
  data: z.object({
    cliVersion: z.string(),
    code: z.string(),
    reason: z.string().optional(),
    modelIndex: z.number().optional(),
  }),
});

test("Cursor discovery logs rejected rows locally with its SDK version and caches the healthy catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-cursor-catalog-"));
  const entry = join(home, "fake-host.mjs");
  const payload = join(home, "models.json");
  const requests = join(home, "requests.jsonl");
  await writeFile(
    payload,
    JSON.stringify([
      {
        id: "healthy",
        displayName: "Healthy",
        variants: [
          { displayName: "Default", isDefault: true, params: [{ id: "speed", value: "" }] },
        ],
      },
      { id: null, displayName: "private-malformed-name" },
      { id: "second", displayName: "Second", parameters: null },
    ]),
  );
  await writeFile(
    entry,
    `
import { createInterface } from 'node:readline';
import { appendFile, readFile } from 'node:fs/promises';
createInterface({ input: process.stdin }).on('line', async line => {
  const input = JSON.parse(line);
  await appendFile(${JSON.stringify(requests)}, JSON.stringify(input.method) + '\\n');
  if (input.method !== 'models') process.exit(9);
  console.log(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: JSON.parse(await readFile(${JSON.stringify(payload)}, 'utf8')) }));
});
`,
  );
  const directory = join(home, "logs");
  const log = createLogger({
    sink: await createFileSink({ directory, fileBytes: 65536, totalBytes: 131072, context: {} }),
    now: () => 1,
    redact: createRedactor({}),
    level: "warn",
  });
  const store = new Store(join(home, "store.sqlite"));
  const resources = new Resources();
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home }),
    options: {
      modelInstances: [
        {
          id: "synthetic-sdk",
          provider: "cursor",
          backend: "cursor-sdk",
          homeDir: join(home, "instance"),
          cwd: home,
          loginRevision: "synthetic-revision",
        },
      ],
      modelDiscovery: {
        spawn: (options) =>
          spawnSupervised({ ...options, command: process.execPath, args: [entry] }),
      },
    },
    store,
    resources,
    log,
    now: () => 1,
    id: () => "id",
    signal: new AbortController().signal,
    services: {},
    onListen: [],
  };
  try {
    await startModels(context);
    const models = context.services.models;
    if (!models) throw new Error("Missing model service");
    await models.refresh();
    const list = models.list();
    expect(list.models.map((model) => model.id)).toEqual(["healthy", "second"]);
    expect(list.instances[0]).toMatchObject({ stale: false, refreshing: false });
    expect(list.instances[0]?.errorDetail).toBeUndefined();
    await log.flush();
    const text = await readFile(join(directory, "ace.jsonl"), "utf8");
    const warnings = text
      .trim()
      .split("\n")
      .map((line) => record.parse(JSON.parse(line)));
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "Model metadata entry rejected",
        data: expect.objectContaining({
          cliVersion: "1.0.35",
          code: "parse_failure",
          modelIndex: 1,
          reason: "Model identity must be a non-empty string of at most 256 characters.",
        }),
      }),
    ]);
    expect(text).not.toContain("private-malformed-name");
    expect(JSON.stringify(list)).not.toContain("Model identity must");
    models.list();
    models.list();
    expect(await readFile(requests, "utf8")).toBe('"models"\n');

    // A wholly broken refresh preserves the last-good cache and the SDK version in diagnostics.
    await writeFile(payload, JSON.stringify([{ id: null, displayName: "private-malformed-name" }]));
    await models.refresh();
    expect(models.list().models.map((model) => model.id)).toEqual(["healthy", "second"]);
    expect(models.list().instances[0]?.errorDetail?.code).toBe("parse_failure");
    await log.flush();
    const latest = (await readFile(join(directory, "ace.jsonl"), "utf8")).trim().split("\n").at(-1);
    const failure = record.parse(JSON.parse(latest ?? "{}"));
    expect(failure).toMatchObject({
      message: "Model discovery failed",
      data: { cliVersion: "1.0.35", code: "parse_failure" },
    });
    expect(failure.data.reason).toBeUndefined();
    await resources.close();
    const persisted = await readFile(join(home, "models.sqlite"));
    expect(persisted.includes(Buffer.from("Model identity must"))).toBe(false);
    expect(persisted.includes(Buffer.from("private-malformed-name"))).toBe(false);
  } finally {
    await resources.close();
    await log.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
