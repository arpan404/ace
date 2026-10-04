import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelDiscovery } from "./index.ts";
import { fakeCli, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test("OpenCode CLI metadata lists provider-qualified choices even when the server catalog is empty", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const config = {
    ...instance("opencode"),
    cwd: work.path,
    args: [await fakeCli(work.path)],
    env: {
      HOME: work.path,
      FAKE_PROVIDER: "opencode",
      FAKE_PAYLOAD: JSON.stringify([
        { id: "same-model", providerID: "one", name: "One" },
        { id: "same-model", providerID: "two", name: "Two" },
      ]),
    },
  };
  const rows = await createModelDiscovery()(config, new AbortController().signal);
  expect(rows.map((row) => [row.id, row.nativeProviderId, row.nativeModelId])).toEqual([
    ["one/same-model", "one", "same-model"],
    ["two/same-model", "two", "same-model"],
  ]);
});

test("Pi metadata uses only get_available_models with no persisted session or extension startup", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const script = join(work.path, "pi.mjs");
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
if (!['--mode','rpc','--no-session','--no-extensions','--no-tools'].every(arg => process.argv.includes(arg))) process.exit(7);
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'get_available_models') process.exit(8);
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
});
