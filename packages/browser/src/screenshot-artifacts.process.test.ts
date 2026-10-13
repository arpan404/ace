import { readFile } from "node:fs/promises";
import type { BrowserArtifact } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executablePath, fixture } from "./test-support.ts";

describe.skipIf(!executablePath)("browser screenshot artifacts", () => {
  it("keeps a person's screenshot as a thread artifact but not an agent's", async () => {
    const published: { threadId: string; artifact: BrowserArtifact }[] = [];
    const f = await fixture({
      onArtifact: (threadId, artifact) => {
        published.push({ threadId, artifact });
      },
    });
    await f.navigate();
    await f.service.execute("thread", { action: "screenshot" }, { kind: "agent" });
    expect(published).toEqual([]);
    const shot = z
      .object({ path: z.string() })
      .parse(
        await f.service.execute(
          "thread",
          { action: "screenshot" },
          { kind: "human", connectionId: "cli" },
        ),
      );
    const bytes = await readFile(shot.path);
    expect(published).toEqual([
      {
        threadId: "thread",
        artifact: { path: shot.path, mimeType: "image/png", bytes: bytes.byteLength },
      },
    ]);
  }, 60_000);
});
