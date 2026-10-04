import { afterEach, expect, test } from "vitest";
import { writeFile, copyFile, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSupervised, type ProcessExit } from "@ace/provider-kit/process";
import { createModelDiscovery } from "./index.ts";
import { instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

// Mutations 11, 19: lose qualification or launch obsolete models --verbose.
// Not executed (tests run at merge).
for (const empty of [false, true])
  test(`OpenCode v2 owned metadata and ID-only fallback populate choices (empty=${empty})`, async () => {
    const work = await workspace();
    cleanup.push(work.close);
    const executable = join(work.path, "opencode");
    await copyFile(
      new URL("../../adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
      executable,
    );
    await chmod(executable, 0o700);
    const rows = await createModelDiscovery()(
      {
        ...instance("opencode"),
        executable,
        cwd: work.path,
        env: { HOME: work.path, ACE_TEST_EMPTY_MODELS: String(empty), ACE_TEST_METADATA_ONLY: "1" },
      },
      new AbortController().signal,
    );
    expect(rows.map((row) => [row.id, row.nativeProviderId, row.nativeModelId])).toEqual([
      ["opencode-go/muse-spark-1.3-contributor", "opencode-go", "muse-spark-1.3-contributor"],
    ]);
    if (!empty)
      expect(rows[0]).toMatchObject({ contextWindow: 200000, reasoningEfforts: ["high"] });
  });

test("OpenCode rejects metadata from a different location", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const executable = join(work.path, "opencode");
  await copyFile(
    new URL("../../adapter-opencode/src/testing/cli-v2.mjs", import.meta.url),
    executable,
  );
  await chmod(executable, 0o700);
  await expect(
    createModelDiscovery()(
      {
        ...instance("opencode"),
        executable,
        cwd: work.path,
        env: { HOME: work.path, ACE_TEST_MODEL_LOCATION: "/wrong" },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("Pi metadata uses only get_available_models with no persisted session or extension startup", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const script = join(work.path, "pi.mjs");
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
import {writeFileSync} from 'node:fs';
if (!process.argv.includes('--no-session')) writeFileSync(process.env.HOME+'/session-created', 'persisted');
if (!process.argv.includes('--no-extensions')) writeFileSync(process.env.HOME+'/extension-started', 'side effect');
if (!process.argv.includes('--no-tools')) process.exit(7);
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'get_available_models') process.exit(8);
  console.log('unrelated startup text');
  console.log(JSON.stringify({type:'agent_start'}));
  console.log(JSON.stringify({type:'response',id:request.id,command:'get_state',success:true,data:{}}));
  console.log(JSON.stringify({type:'response',id:'other',command:'get_available_models',success:true,data:{models:[]}}));
  console.log(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{models:[
    {id:'same-model',provider:'one',name:'One',contextWindow:64000,input:['text','image']},
    {id:'same-model',provider:'two',name:'Two',contextWindow:128000}
  ]}}));
});`,
  );
  const rows = await createModelDiscovery()(
    {
      ...instance("pi"),
      args: [script],
      cwd: work.path,
      env: { HOME: work.path },
    },
    new AbortController().signal,
  );
  expect(rows.map((row) => [row.id, row.contextWindow])).toEqual([
    ["one/same-model", 64000],
    ["two/same-model", 128000],
  ]);
  expect(rows[0]?.inputModalities).toEqual(["text", "image"]);
  expect(await readdir(work.path)).not.toContain("session-created");
  expect(await readdir(work.path)).not.toContain("extension-started");
});

for (const mode of ["flood", "malformed", "failed"])
  test(`Pi refuses ${mode} metadata and reaps the owned process`, async () => {
    const work = await workspace();
    cleanup.push(work.close);
    const script = join(work.path, "pi-bad.mjs");
    await writeFile(
      script,
      `
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  const reply={type:'response',id:r.id,command:r.type,success:true,data:{models:[]}};
  if (${JSON.stringify(mode)}==='malformed') reply.data.models='invalid';
  if (${JSON.stringify(mode)}==='failed') reply.success=false;
  if (${JSON.stringify(mode)}==='flood') process.stdout.write('x'.repeat(5*1024*1024));
  else console.log(JSON.stringify(reply));
});`,
    );
    let exited: Promise<ProcessExit> | undefined;
    await expect(
      createModelDiscovery({
        spawn(options) {
          const proc = spawnSupervised(options);
          exited = proc.exited;
          return proc;
        },
      })(
        { ...instance("pi"), args: [script], cwd: work.path, env: { HOME: work.path } },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(await exited).toMatchObject({
      reason: mode === "flood" ? "output-limit" : "stopped",
    });
  });

// Boundary outcome: output overflow detected during cleanup after a valid reply.
// Not executed (tests run at merge).
test("Pi rejects a valid listing when supervision reports an output-limit during cleanup", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const script = join(work.path, "pi-cleanup.mjs");
  await writeFile(
    script,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
const r=JSON.parse(line); console.log(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{models:[]}}));
});`,
  );
  let exited: Promise<ProcessExit> | undefined;
  await expect(
    createModelDiscovery({
      spawn(options) {
        const proc = spawnSupervised(options);
        exited = proc.exited;
        return {
          ...proc,
          async stop(stopOptions) {
            const exit = await proc.stop(stopOptions);
            return { ...exit, reason: "output-limit" };
          },
        };
      },
    })(
      { ...instance("pi"), args: [script], cwd: work.path, env: { HOME: work.path } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("output limit");
  expect(await exited).toMatchObject({ reason: "stopped" });
});

test("cancelling Pi metadata while unrelated events arrive reaps its process", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const script = join(work.path, "pi-hung.mjs");
  await writeFile(
    script,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', () => console.log(JSON.stringify({type:'agent_start'})));`,
  );
  const controller = new AbortController(),
    ready = Promise.withResolvers<void>();
  let exited: Promise<ProcessExit> | undefined;
  const discovery = createModelDiscovery({
    spawn(options) {
      const proc = spawnSupervised(options);
      exited = proc.exited;
      proc.stdout.on("line", () => ready.resolve());
      return proc;
    },
  })(
    { ...instance("pi"), args: [script], cwd: work.path, env: { HOME: work.path } },
    controller.signal,
  );
  try {
    await ready.promise;
    controller.abort();
    await expect(discovery).rejects.toThrow();
    expect(await exited).toMatchObject({ reason: "stopped" });
  } finally {
    controller.abort();
    await discovery.catch(() => {});
  }
});

for (const count of [512, 513])
  test(`Pi metadata accepts at most 512 qualified choices (count=${count})`, async () => {
    const work = await workspace();
    cleanup.push(work.close);
    const script = join(work.path, "pi-cap.mjs");
    await writeFile(
      script,
      `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
const r=JSON.parse(line); console.log(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data:{models:Array.from({length:${count}}, (_,i) => ({id:'family/model-'+i,provider:'local',name:'Model '+i}))}}));
});`,
    );
    const discovery = createModelDiscovery()(
      { ...instance("pi"), args: [script], cwd: work.path, env: { HOME: work.path } },
      new AbortController().signal,
    );
    if (count === 513) await expect(discovery).rejects.toThrow();
    else {
      const rows = await discovery;
      expect(rows).toHaveLength(512);
      expect(rows[511]).toMatchObject({
        id: "local/family/model-511",
        nativeProviderId: "local",
        nativeModelId: "family/model-511",
      });
    }
  });
