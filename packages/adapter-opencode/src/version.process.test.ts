import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { createOpenCodeAdapter } from "./testing/v1/index.ts";
const cli = fileURLToPath(new URL("./testing/cli.mjs", import.meta.url));
for (const version of ["1.18.32", "2.0.0", "unrecognized"]) {
  it(`refuses to start sessions with unsupported CLI version ${version}`, async () => {
    const adapter = createOpenCodeAdapter({
      discovery: {
        overrides: { opencode: cli, claude: cli, codex: cli, cursor: cli },
        env: { ACE_TEST_OPENCODE_VERSION: version },
      },
    });
    try {
      await expect(
        adapter.openSession({
          threadId: ThreadId.parse("thread_version"),
          cwd: process.cwd(),
          onFrame: () => {},
          onExit: () => {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("OpenCode >=1.18.33 and <2");
    } finally {
      await adapter.close();
    }
  });
}
