import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { openAcpSession, genericQuirks } from "./index.ts";

const server = fileURLToPath(new URL("./testing/negotiation-server.ts", import.meta.url));
const Prompt = z.object({
  method: z.literal("session/prompt"),
  params: z.object({ prompt: z.array(z.object({ text: z.string().optional() }).passthrough()) }),
});

test("ACP sends ace's guidance with the first prompt only, not again on later turns", async () => {
  const frames: Frame[] = [];
  let briefs = 0;
  const session = await openAcpSession(
    {
      threadId: ThreadId.parse("synthetic"),
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onFrame: (frame) => void frames.push(frame),
      onExit() {},
      mcp: {
        httpServers: [{ name: "ace", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] }],
        secrets: [],
        end() {},
      },
      aceMcp: {
        url: "http://127.0.0.1:1/mcp",
        bearer: "b".repeat(64),
        session: () => ({ brief: `ace session facts, read ${++briefs}` }),
      },
    },
    genericQuirks,
    {
      command: process.execPath,
      args: [server],
      env: { ACE_SYNTHETIC_ACP: JSON.stringify({ http: true }) },
    },
  );
  const prompts = () =>
    frames.flatMap((frame) => {
      const parsed = Prompt.safeParse(frame.data);
      return frame.dir === "send" && parsed.success
        ? [parsed.data.params.prompt.map((part) => part.text ?? "").join("\n")]
        : [];
    });
  try {
    for (const text of ["first", "second", "third"]) {
      await session.send([{ type: "text", text }], "queue");
      for (let attempt = 0; attempt < 200 && !prompts().some((p) => p.endsWith(text)); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = prompts();
    expect(sent).toHaveLength(3);
    expect(sent[0]).toContain("<ace-tool-guidance>");
    expect(sent[0]).toContain("ace session facts");
    expect(sent.slice(1).some((prompt) => prompt.includes("ace-tool-guidance"))).toBe(false);
    expect(sent.slice(1)).toEqual(["second", "third"]);
  } finally {
    await session.close("user");
  }
});
