import { expect, test } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelDiscovery } from "./index.ts";
import { instance, workspace } from "./testing/support.ts";

test("persisted OpenCode v1 bindings report not installed without entering v2 auth or model APIs", async () => {
  const work = await workspace();
  try {
    const script = join(work.path, "old-opencode.mjs");
    const calls = join(work.path, "calls");
    await writeFile(
      script,
      `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},process.argv.slice(2).join(' ')+String.fromCharCode(10));if(process.argv.includes('--version'))console.log('1.18.4');else{console.log('[]');process.exit(7);}`,
    );
    const config = {
      ...instance("opencode"),
      cwd: work.path,
      args: [script],
      env: { HOME: work.path },
    };
    await expect(
      createModelDiscovery()(config, new AbortController().signal),
    ).rejects.toMatchObject({ discoveryCode: "not_installed" });
    expect(await readFile(calls, "utf8")).toBe("--version\n");
  } finally {
    await work.close();
  }
});
