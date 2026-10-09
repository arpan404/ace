import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const cwd = "/synthetic/workspace";
const line = (value: unknown) => JSON.stringify(value) + "\n";
async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line(value));
}
/** Real measured maxima and record envelopes, with invented text, written in bounded chunks. */
async function transcript(
  path: string,
  bytes: number,
  recordBytes: number,
  head: string,
  tail: string,
  envelope: string,
) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w");
  const chunk = Buffer.alloc(64 * 1024, "x");
  const end = '"}}\n';
  try {
    await file.write(head);
    let remaining = bytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
    while (remaining > 0) {
      const size = Math.min(recordBytes, remaining);
      if (size < envelope.length + end.length) {
        await file.write(" ".repeat(size));
        break;
      }
      await file.write(envelope);
      let padding = size - envelope.length - end.length;
      while (padding) {
        const part = Math.min(chunk.length, padding);
        await file.write(chunk.subarray(0, part));
        padding -= part;
      }
      await file.write(end);
      remaining -= size;
    }
    await file.write(tail);
  } finally {
    await file.close();
  }
}
export async function coldHistoryFixture(root: string) {
  const opencode = join(root, "opencode");
  for (let start = 0; start < 6000; start += 24)
    await Promise.all(
      Array.from({ length: Math.min(24, 6000 - start) }, async (_, offset) => {
        const id = `session-${start + offset}`;
        await put(join(opencode, "storage/session/project", `${id}.json`), {
          id,
          directory: cwd,
          title: `Check reconnect ${start + offset}`,
          time: { created: 1, updated: 2 },
          future: { unrecognized: true },
        });
        await put(join(opencode, "storage/message", id, `${id}-input.json`), {
          id: `${id}-input`,
          role: "user",
          time: { created: 1 },
        });
        await put(join(opencode, "storage/part", `${id}-input`, "text.json"), {
          type: "text",
          text: "Check the reconnect path",
        });
      }),
    );
  await transcript(
    join(opencode, "storage/message/session-0/session-0-input.json"),
    15583308,
    15583308,
    "",
    "",
    '{"id":"session-0-input","role":"user","legacy":{"text":"',
  );
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  await transcript(
    join(codex, "sessions/large.jsonl"),
    1876966062,
    12475070,
    line({ type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd } }) +
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the reconnect" }],
        },
      }),
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The reconnect is fixed." }],
      },
    }),
    '{"type":"response_item","payload":{"type":"function_call_output","call_id":"large-output","output":"',
  );
  await transcript(
    join(claude, "projects/project/large.jsonl"),
    154944123,
    1519447,
    line({
      type: "user",
      sessionId: "claude-large",
      cwd,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Fix the restart" },
    }),
    line({
      type: "assistant",
      sessionId: "claude-large",
      message: { role: "assistant", content: [{ type: "text", text: "The restart is fixed." }] },
    }),
    '{"type":"attachment","attachment":{"type":"tool-output","text":"',
  );
  return [
    { id: "fixture-opencode", provider: "opencode" as const, homeDir: opencode },
    { id: "fixture-codex", provider: "codex" as const, homeDir: codex },
    { id: "fixture-claude", provider: "claude" as const, homeDir: claude },
  ];
}
