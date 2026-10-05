import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AcpIdentity, ThreadId } from "@ace/protocol";
import type { ProviderSession } from "@ace/engine-api";
import { createAcpAdapter } from "./index.ts";

test("registry approval keeps its executable authoritative when the session requests a replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-approved-acp-"));
  let session: ProviderSession | undefined;
  try {
    for (const name of ["approved", "replacement"])
      await writeFile(
        join(home, name),
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(home, name + ".ran"))}, 'started'); await import(${JSON.stringify(new URL("./testing/acp-server.ts", import.meta.url).href)});\n`,
        { mode: 0o700 },
      );
    const identity = AcpIdentity.parse({
      acpAgentId: "local:approved",
      installationId: "installation-approved",
      instanceId: "account",
    });
    session = await createAcpAdapter(undefined, {
      resolveLaunch: async () => ({
        identity,
        version: "1.2.1",
        command: join(home, "approved"),
        args: [],
        env: { HOME: home },
      }),
    }).openSession({
      threadId: ThreadId.parse("approved-launch"),
      cwd: home,
      acpIdentity: identity,
      executable: join(home, "replacement"),
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    });
    expect(session.nativeSessionId).toBe("native-root");
    expect(await readFile(join(home, "approved.ran"), "utf8")).toBe("started");
    await expect(readFile(join(home, "replacement.ran"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await session?.close("shutdown");
    await rm(home, { recursive: true, force: true });
  }
});
