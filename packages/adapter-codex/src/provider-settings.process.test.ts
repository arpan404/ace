import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Frame, ProviderSession } from "@ace/engine-api";
import { createCodexAdapter } from "./index.ts";

test("a custom executable supersedes the discovered binary, preserves custom model ids and probes no other provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-codex-override-"));
  const executable = join(home, "custom-codex");
  const marker = join(home, "other-provider");
  let session: ProviderSession | undefined;
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nimport ${JSON.stringify(new URL("./testing/cli.ts", import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
    for (const name of ["claude", "opencode", "agent"])
      await writeFile(
        join(home, name),
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'probed');\n`,
        { mode: 0o700 },
      );
    const frames: Frame[] = [];
    session = await createCodexAdapter({
      cli: {
        installed: true,
        path: join(home, "obsolete"),
        version: "0.159.1",
        auth: "logged_in",
        loginHint: "fake CLI",
      },
      discovery: { env: { HOME: home, PATH: home } },
      runtime: { stopGraceMs: 0 },
    }).openSession({
      threadId: ThreadId.parse("custom-model"),
      cwd: home,
      executable,
      model: "user-router/My_Exact.Model-v2",
      signal: new AbortController().signal,
      onFrame: (frame) => frames.push(frame),
      onExit: () => {},
    });
    expect(session.nativeSessionId).toBe("native");
    const start = frames.find(
      (frame) =>
        frame.dir === "send" &&
        z.object({ method: z.string() }).safeParse(frame.data).data?.method === "thread/start",
    );
    expect(
      z.object({ params: z.object({ model: z.string() }) }).parse(start?.data).params.model,
    ).toBe("user-router/My_Exact.Model-v2");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await session?.close("shutdown");
    await rm(home, { recursive: true, force: true });
  }
});
