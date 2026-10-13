import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test.each(["codex", "claude"])(
  "%s login drains a reviewed Enter fallback so the next CLI attempt is not busy",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "ace-login-fallback-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const marker = join(root, "drained");
    await nodeBinary(
      bin,
      provider,
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) console.log(${JSON.stringify(provider === "codex" ? "codex-cli 0.159.1" : "2.1.286")});
else if (args.includes('--help')) console.log('login logout --device-auth --claudeai');
else if (args.includes('status')) console.log(${JSON.stringify(provider === "codex" ? "Not logged in" : '{"loggedIn":false}')});
else {
 console.log(${JSON.stringify(provider === "codex" ? "Open https://auth.openai.com/codex/device\nEnter code: ABCD-12345\nPress Enter to continue." : "Open https://claude.ai/oauth/authorize?client_id=synthetic&response_type=code&code_challenge=fixture\nPress Enter to continue.")});
 process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(marker)}, 'drained\\n'); process.exit(0); });
 setInterval(() => {}, 1000);
}
`,
    );
    const f = await daemonFixture(undefined, {
      accounts: {
        env: {
          ...process.env,
          HOME: root,
          PATH: bin,
          CODEX_HOME: undefined,
          CLAUDE_CONFIG_DIR: undefined,
        },
      },
    });
    try {
      const home = join(f.h.home, "daemon");
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await invoke(home, ["login", provider, "--json", "--timeout", "10s"]);
        expect(output.code, output.stderr).toBe(2);
        expect(JSON.parse(output.stdout)).toMatchObject({
          sessionReleased: true,
          manual: { action: "open_terminal" },
        });
      }
      expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await f.daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
