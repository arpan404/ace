import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nodeBinary } from "../testing/cli.ts";
import { discoverPiStatus } from "./pi-status.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(version: string, configured: boolean) {
  const root = await mkdtemp(join(tmpdir(), "ace-pi-readiness-"));
  roots.push(root);
  const profile = join(root, "profile");
  await mkdir(profile);
  if (configured)
    await writeFile(
      join(profile, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", unknownSetting: { retained: true } }),
    );
  const executable = await nodeBinary(
    root,
    "pi",
    `
    const args = process.argv.slice(2);
    if(args[0]==='--version') console.log('${version}');
    else if(args[0]==='auth' && args[1]==='check' && args.includes('--no-refresh') && args.includes('--json')) {
      const provider=args[args.indexOf('--provider')+1];
      const ready=provider==='openai-codex';
      console.log(JSON.stringify(ready?{status:'ready',authType:'oauth',unknownField:{future:true}}:{status:'not_ready',reason:'credentials_not_configured'}));
      process.exitCode=ready?0:1;
    } else { console.log('Unsupported command');process.exitCode=2; }
  `,
  );
  return { executable, env: { HOME: root, PI_CODING_AGENT_DIR: profile, PATH: root } };
}

test.each(["0.85.1", "1.1.0"])(
  "Pi %s notices a first OAuth login without a settings file",
  async (version) => {
    expect(await discoverPiStatus(await fixture(version, false))).toMatchObject({
      installed: true,
      auth: "logged_in",
      authDetail: "oauth",
    });
  },
);
test("Pi stays usable through Codex while its configured Claude service is signed out", async () => {
  expect(await discoverPiStatus(await fixture("1.1.0", true))).toMatchObject({ auth: "logged_in" });
});
test("an unreviewed Pi release remains unknown without running an auth command", async () => {
  expect(await discoverPiStatus(await fixture("9.0.0", false))).toMatchObject({
    auth: "unknown",
    error: "Pi auth status is unsupported for this version",
  });
});
