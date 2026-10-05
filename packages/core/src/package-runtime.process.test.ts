import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { expect, test } from "vitest";
const manifest = z.object({ name: z.string(), dependencies: z.record(z.string(), z.string()) });
const execute = promisify(execFile);
/**
 * Finds a dependency's installed root the way Node's resolver walks node_modules.
 * Resolving the package's main entry would fail for subpath-only packages.
 */
async function packageRoot(name: string, from: string): Promise<string> {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    try {
      await access(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) throw new Error(`No package root for ${name}`);
  }
}
/** An isolated consumer cannot accidentally use a dependency from an ancestor checkout. */
test("an isolated core consumer validates native wait targets and preserves active work", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ace-core-consumer-"));
  try {
    const source = fileURLToPath(new URL("./", import.meta.url));
    const target = join(sandbox, "core");
    await cp(source, join(target, "src"), { recursive: true });
    const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
    const text = await readFile(packageJson, "utf8");
    await writeFile(join(target, "package.json"), text);
    const dependencies = manifest.parse(JSON.parse(text)).dependencies;
    for (const name of Object.keys(dependencies)) {
      const directory = await packageRoot(name, dirname(packageJson));
      const link = join(target, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(directory, link, "dir");
    }
    const entry = join(sandbox, "node_modules", "@ace", "core");
    await mkdir(dirname(entry), { recursive: true });
    await symlink(target, entry, "dir");
    const script = join(sandbox, "consumer.mjs");
    await writeFile(
      script,
      `import {apply, createThreadState} from '@ace/core';
const state = createThreadState({threadId: 'consumer', config: {provider: 'codex', silenceMs: 1000}});
let n = 0; const ctx = {now: 0, ids: {next: kind => kind + (++n)}};
apply(state, {type: 'turn.started', agent: 'root', trigger: 'user'}, ctx);
apply(state, {type: 'item.upsert', agent: 'root', item: 'wait', draft: {type: 'tool_call', call: {kind: 'agent.message', status: 'running', detail: {kind: 'agent.message', message: 'wait'}}}}, ctx);
const events = apply(state, {type: 'subagents.waiting', agent: 'root', item: 'wait', targets: [42]}, ctx);
console.log(JSON.stringify({state: state.status.state, rejected: events.some(e => e.type === 'item.created' && e.item.type === 'notice' && e.item.raw.some(r => r.type === 'core.rejected_fact'))}));`,
    );
    const result = await execute(process.execPath, [script], { cwd: sandbox });
    expect(JSON.parse(result.stdout)).toEqual({ state: "working", rejected: true });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
