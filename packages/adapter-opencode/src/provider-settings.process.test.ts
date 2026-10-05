import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import type { ProviderSession } from "@ace/engine-api";
import { createOpenCodeAdapter } from "./index.ts";

test("a custom OpenCode executable opens its owned server without discovering other providers", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-opencode-override-"));
  const executable = join(home, "custom-opencode");
  const marker = join(home, "other-provider");
  let session: ProviderSession | undefined;
  const adapter = createOpenCodeAdapter({ discovery: { env: { HOME: home, PATH: home } } });
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/cli-v2.mjs", import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
    for (const name of ["claude", "codex", "agent"])
      await writeFile(
        join(home, name),
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'probed');\n`,
        { mode: 0o700 },
      );
    session = await adapter.openSession({
      threadId: ThreadId.parse("custom-binary"),
      cwd: home,
      executable,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    });
    expect(session.nativeSessionId).toBe("session-1");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await session?.close("shutdown");
    await adapter.close();
    await rm(home, { recursive: true, force: true });
  }
});
