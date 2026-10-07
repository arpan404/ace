import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createFileSink, createLogger } from "@ace/diagnostics";
import { createRedactor } from "@ace/redaction";
import { startModels } from "./services/models.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import { Store } from "./store.ts";
import type { ServiceContext } from "./services/types.ts";

const records = z.array(
  z.object({
    level: z.string(),
    message: z.string(),
    data: z.unknown(),
  }),
);

test.each(["source", "instance"] as const)(
  "%s discovery failures persist provider, account, source, code, version and elapsed time without secrets",
  async (scope) => {
    const home = await mkdtemp(join(tmpdir(), "ace-discovery-log-"));
    const executable = join(home, "opencode");
    const connections = [
      {
        id: "synthetic-cloud",
        name: "Synthetic Cloud",
        connections: [{ type: "auth", authType: "api" }],
        credentials: "private-auth-status",
      },
      ...(scope === "instance"
        ? [{ id: "healthy-cloud", name: "Healthy Cloud", connections: [{ type: "env" }] }]
        : []),
    ];
    await writeFile(
      executable,
      `#!${process.execPath}
const args = process.argv.slice(2);
console.error("private-cli-stderr Bearer private-cli-bearer");
if (args.join(' ') === '--version') console.log('2.1.0');
else if (args.join(' ') === 'auth list --standalone --format json') {
  console.log(${JSON.stringify(JSON.stringify(connections))});
} else { console.error('private-cli-stderr Bearer private-cli-bearer'); process.exit(9); }
`,
      { mode: 0o700 },
    );
    const logContext = { env: { CUSTOM_API_KEY: "private-environment" } };
    const directory = join(home, "logs");
    const log = createLogger({
      sink: await createFileSink({
        directory,
        fileBytes: 65536,
        totalBytes: 131072,
        context: logContext,
      }),
      now: () => 1,
      redact: createRedactor(logContext),
      level: "warn",
    });
    const store = new Store(join(home, "store.sqlite"));
    const resources = new Resources();
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: home }),
      options: {
        modelInstances: [
          {
            id: "synthetic-account",
            provider: "opencode",
            executable,
            cwd: home,
            loginRevision: "synthetic-revision",
            env: { HOME: home, CUSTOM_API_KEY: "private-environment" },
          },
        ],
        modelDiscovery: {
          async opencode(instance) {
            const error = {
              status: 401,
              message: "Unauthorized Bearer private-api-bearer",
              credentials: { password: "private-password" },
              stderr: "private-provider-stderr",
            };
            if (scope === "instance") throw error;
            return {
              location: { directory: instance.cwd },
              data: [],
              errors: [{ providerID: "synthetic-cloud", error }],
            };
          },
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
      await log.flush();
      const persisted = await readFile(join(directory, "ace.jsonl"), "utf8");
      for (const lines of [persisted.trim().split("\n"), log.recent()]) {
        const warnings = records.parse(lines.map((line) => JSON.parse(line)));
        expect(warnings).toEqual([
          {
            level: "warn",
            message: "Model discovery failed",
            data: expect.objectContaining({
              provider: "opencode",
              instance: "synthetic-account",
              source: scope === "source" ? "synthetic-cloud" : null,
              sourceLabel: scope === "source" ? "Synthetic Cloud" : null,
              stage: "metadata",
              code: "auth_expired",
              message: "Provider sign-in has expired.",
              cliVersion: "2.1.0",
              durationMs: expect.any(Number),
              retryInMs: expect.any(Number),
            }),
          },
        ]);
        const detail = z.object({ durationMs: z.number().nonnegative() }).parse(warnings[0]?.data);
        expect(Number.isFinite(detail.durationMs)).toBe(true);
        const text = lines.join("\n");
        for (const secret of [
          "private-auth-status",
          "private-cli-stderr",
          "private-cli-bearer",
          "private-environment",
          "private-api-bearer",
          "private-password",
          "private-provider-stderr",
        ])
          expect(text).not.toContain(secret);
        expect(text).not.toContain("UNPREPARED OBJECT OMITTED");
      }
    } finally {
      await resources.close();
      await log.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Pi discovery and connection reconciliation retain the source learned before state metadata fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-pi-discovery-log-"));
  const executable = join(home, "pi");
  await writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
console.error('private-pi-stderr Bearer private-pi-bearer');
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  const data=request.type==='get_available_models' ? {models:[{id:'coder',provider:'openai',name:'Coder',credentials:'private-pi-credentials'}]} : {error:'private-pi-error'};
  console.log(JSON.stringify({type:'response',id:request.id,command:request.type,success:request.type==='get_available_models',data}));
});
`,
    { mode: 0o700 },
  );
  const log = createLogger({
    sink: { async write() {}, async close() {} },
    now: () => 1,
    redact: createRedactor({}),
    level: "warn",
  });
  const resources = new Resources();
  const store = new Store(join(home, "store.sqlite"));
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home }),
    options: {
      modelInstances: [
        {
          id: "pi-account",
          provider: "pi",
          installationVersion: "0.72.0",
          executable,
          cwd: home,
          env: { HOME: home },
          loginRevision: "synthetic",
        },
      ],
    },
    log,
    resources,
    store,
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
    await models.reconcileConnections();
    const warnings = records.parse(log.recent().map((line) => JSON.parse(line)));
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning).toMatchObject({
        message: "Model discovery failed",
        data: {
          provider: "pi",
          instance: "pi-account",
          source: "openai",
          sourceLabel: "OpenAI",
          stage: null,
          code: "parse_failure",
          cliVersion: "0.72.0",
          message: "Provider returned unreadable model metadata.",
          durationMs: expect.any(Number),
        },
      });
      const detail = z.object({ durationMs: z.number().nonnegative() }).parse(warning.data);
      expect(Number.isFinite(detail.durationMs)).toBe(true);
    }
    const text = log.recent().join("\n");
    for (const secret of [
      "private-pi-stderr",
      "private-pi-bearer",
      "private-pi-credentials",
      "private-pi-error",
    ])
      expect(text).not.toContain(secret);
  } finally {
    await resources.close();
    await log.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
