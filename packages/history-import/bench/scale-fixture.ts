import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const cwd = "/synthetic/project";
async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value) + "\n");
}
/** Synthetic text only; sizes measured from allowlisted native transcripts in October 2026. */
export async function scaleFixture(root: string, count = 6000) {
  const homes = ["opencode", "codex", "claude"] as const;
  for (const provider of homes) await mkdir(join(root, provider), { recursive: true });
  for (let start = 0; start < count; start += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, count - start) }, async (_, offset) => {
        const i = start + offset;
        const id = `saved-${i}`;
        await json(join(root, "opencode/storage/session/p", id + ".json"), {
          id,
          directory: cwd,
          title: "Title request: Check reconnect retries",
          time: { created: 1, updated: 2 },
        });
        await json(join(root, "opencode/storage/message", id, id + ".json"), {
          id,
          role: "user",
          time: { created: 1 },
          ...(i === 0 ? { legacy: "x".repeat(176700) } : {}),
        });
        await json(join(root, "opencode/storage/part", id, "part.json"), {
          type: "text",
          text: "Check reconnect retries",
        });
      }),
    );
  }
  for (const [provider, files, median, p95, maximum] of [
    ["codex", 5352, 960537, 14946782, 1876966062],
    ["claude", 1027, 1503, 8008496, 154914603],
  ] as const) {
    const directory = join(root, provider, provider === "codex" ? "sessions" : "projects/p");
    await mkdir(directory, { recursive: true });
    for (let i = 0; i < files; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const records =
        provider === "codex"
          ? [
              { type: "session_meta", payload: { id, cwd } },
              {
                type: "response_item",
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "Find app version" }],
                },
              },
            ]
          : [
              {
                type: "user",
                sessionId: id,
                cwd,
                message: { role: "user", content: "Fix reconnect retries" },
              },
            ];
      const head =
        records.map((r) => JSON.stringify(r)).join("\n") + '\n{"type":"world_state","padding":"';
      const tail =
        '"}\n' + JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n";
      // Holes model oversized opaque records without allocating or writing gigabytes.
      const size = i === 0 ? maximum : i % 20 === 0 ? p95 : median;
      const file = await open(join(directory, `${i}.jsonl`), "w");
      try {
        await file.write(head, 0, "utf8");
        await file.write(tail, size - Buffer.byteLength(tail), "utf8");
      } finally {
        await file.close();
      }
    }
  }
  return {
    cwd,
    instances: homes.map((provider) => ({ id: provider, provider, homeDir: join(root, provider) })),
  };
}
