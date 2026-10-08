import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { expect, onTestFinished, test } from "vitest";
import { bundleDaemon } from "@ace/release";

test("packaged Pi sign-in relays the installed SDK device challenge without a source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-pi-bundle-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(import.meta.dirname, "../../..");
  const installed = join(root, "installed-pi");
  await mkdir(join(installed, "dist"), { recursive: true });
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.1.0",
      main: "./dist/index.js",
      type: "module",
    }),
  );
  const binary = join(installed, "dist", "pi");
  await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await writeFile(
    join(installed, "dist", "index.js"),
    `
export class ModelRuntime {
 static async create() { return new ModelRuntime(); }
 async logout() {}
 async login(provider,type,interaction) {
  if(provider !== 'openai-codex' || type !== 'oauth') throw Error('Wrong provider');
  if(await interaction.prompt({type:'select',options:[{id:'device_code'}]}) !== 'device_code') throw Error('Wrong method');
  interaction.notify({type:'device_code',verificationUri:'https://auth.openai.com/codex/device',userCode:'ABCD-1234'});
  return {access:'private-fixture-credential'};
 }
}`,
  );
  const entry = join(root, "fixture.ts");
  await writeFile(
    entry,
    `
import {piLoginDriver} from ${JSON.stringify(join(repo, "apps/daemon/src/pi-login-driver.ts"))};
const challenges=[];
const driver=piLoginDriver({command:${JSON.stringify(binary)},version:'1.1.0',cwd:process.cwd(),env:{HOME:process.cwd()},action:'login'});
try {
 const result=await driver.run(new AbortController().signal,progress=>{
  if(progress.choices) driver.input({choice:'openai-codex'});
  else challenges.push(progress);
 });
 console.log(JSON.stringify({result,challenges}));
} finally {await driver.drain();}
`,
  );
  await bundleDaemon(repo, root, "", undefined, entry);
  await rm(entry);
  const result = await promisify(execFile)(process.execPath, [join(root, "ace.mjs")], {
    cwd: root,
    env: { HOME: root, PATH: "" },
    maxBuffer: 65536,
  });
  const outcome = z
    .object({
      result: z.object({ success: z.boolean() }),
      challenges: z.array(z.object({ state: z.string(), url: z.string(), userCode: z.string() })),
    })
    .parse(JSON.parse(result.stdout));
  expect(outcome).toEqual({
    result: { success: true },
    challenges: [
      {
        state: "awaiting_code_entry",
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      },
    ],
  });
  expect(result.stdout).not.toContain("private-fixture-credential");
});
