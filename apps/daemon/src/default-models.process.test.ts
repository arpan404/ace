import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@ace/diagnostics";
import { startModels } from "./services/models.ts";
import { Resources } from "./services/resources.ts";
import { readConfig } from "./config.ts";
import { Store } from "./store.ts";
import type { ServiceContext } from "./services/types.ts";

afterEach(() => vi.unstubAllEnvs());
const payload = (model: string) => ({
  data: [
    {
      id: model,
      model,
      displayName: model,
      isDefault: true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "high",
    },
  ],
  nextCursor: null,
});
test("default installed CLI models refresh lazily, cache across restarts and refresh on demand", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-default-models-"));
  const executable = join(home, "codex");
  const listing = join(home, "listing.json");
  await writeFile(listing, JSON.stringify(payload("first")));
  await writeFile(
    executable,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
if (process.argv.at(-1) !== 'app-server') process.exit(7);
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if (r.method === 'initialized') return;
  if (!['initialize','model/list'].includes(r.method)) process.exit(8);
  console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{}:JSON.parse(readFileSync(${JSON.stringify(listing)},'utf8'))}));
});`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", home);
  vi.stubEnv("HOME", home);
  const store = new Store(join(home, "store.sqlite"));
  const log = createLogger({
    now: () => 1,
    redact: (line) => line,
    level: "silent",
    sink: { async write() {}, async close() {} },
  });
  const start = async () => {
    const resources = new Resources();
    const context: ServiceContext = {
      config: readConfig({ ACE_HOME: home }),
      options: {},
      resources,
      store,
      log,
      now: () => 1,
      id: () => "id",
      signal: new AbortController().signal,
      services: {},
      onListen: [],
    };
    await startModels(context);
    const models = context.services.models;
    if (!models) throw new Error("No model service");
    return { models, resources };
  };
  let resources: Resources | undefined;
  try {
    const first = await start();
    resources = first.resources;
    // Admission is background filesystem work; startup does not await a metadata command.
    expect(first.models.list().models).toEqual([]);
    await vi.waitFor(() =>
      expect(first.models.list().instances.map((entry) => entry.provider)).toEqual(["codex"]),
    );
    await first.models.refresh();
    expect(first.models.list().models.map((row) => row.id)).toEqual(["first"]);
    await first.resources.close();
    resources = undefined;
    await writeFile(listing, JSON.stringify(payload("second")));
    const second = await start();
    resources = second.resources;
    await vi.waitFor(() =>
      expect(second.models.list().models.map((row) => row.id)).toEqual(["first"]),
    );
    await second.models.refresh();
    expect(second.models.list().models.map((row) => row.id)).toEqual(["second"]);
  } finally {
    await resources?.close();
    await log.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
