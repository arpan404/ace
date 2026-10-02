import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { expect, test } from "vitest";
const manifest = z.object({ name: z.string(), dependencies: z.record(z.string(), z.string()) });
const execute = promisify(execFile);
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
    const require = createRequire(import.meta.url);
    for (const name of Object.keys(dependencies)) {
      let directory = dirname(require.resolve(name));
      while (true) {
        const candidate = join(directory, "package.json");
        try {
          const parsed = z
            .object({ name: z.string() })
            .parse(JSON.parse(await readFile(candidate, "utf8")));
          if (parsed.name === name) break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`No package root for ${name}`);
        directory = parent;
      }
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
