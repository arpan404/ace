import { expect, test } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { z } from "zod";
import { runStdioBridge } from "./index.ts";

test.each(["application/json", "text/event-stream"])(
  "%s carries rich image results and recovers after an oversized reply",
  async (format) => {
    const input = new PassThrough(),
      output = new PassThrough();
    const lifetime = new AbortController();
    const lines = createInterface({ input: output });
    let answer = Promise.withResolvers<unknown>();
    lines.on("line", (line) => answer.resolve(JSON.parse(line)));
    const sizes = [400_000, 12 * 1024 * 1024 - 1024, 13 * 1024 * 1024, 4];
    const bridge = runStdioBridge({
      connection: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
      input,
      output,
      signal: lifetime.signal,
      async fetch(_input, init) {
        const { id } = z.object({ id: z.number() }).parse(JSON.parse(String(init?.body)));
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "image",
                mimeType: "image/jpeg",
                data: "abcd".repeat(Math.floor((sizes[id - 1] ?? 4) / 4)),
              },
            ],
          },
        });
        return new Response(format === "application/json" ? payload : `data: ${payload}\n\n`, {
          headers: { "content-type": format },
        });
      },
    });
    try {
      for (const id of [1, 2, 3, 4]) {
        answer = Promise.withResolvers<unknown>();
        input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call" }) + "\n");
        const value = await answer.promise;
        if (id === 3) expect(value).toMatchObject({ id, error: { code: -32603 } });
        else {
          const parsed = z
            .object({ result: z.object({ content: z.array(z.object({ data: z.string() })) }) })
            .parse(value);
          expect(parsed.result.content[0]?.data).toBe(
            "abcd".repeat(Math.floor((sizes[id - 1] ?? 4) / 4)),
          );
        }
      }
    } finally {
      lifetime.abort();
      await bridge;
      lines.close();
      output.destroy();
    }
  },
);
