import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { HistoryProvider } from "@ace/protocol/history";
import { openHistory } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "ace-messy-history-bench-"));
const instances = HistoryProvider.options
  .filter((provider) => provider !== "cursor")
  .map((provider) => ({
    id: provider,
    provider,
    homeDir: join(root, provider),
  }));
const cwd = "/synthetic/project";
const write = async (path: string, records: unknown[]) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
let service;
try {
  for (let batch = 0; batch < 6000; batch += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, 6000 - batch) }, async (_, offset) => {
        const index = batch + offset;
        if (index < 5950) {
          const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          await write(join(root, "codex/sessions", `${index}.jsonl`), [
            { type: "session_meta", payload: { id, cwd } },
            { type: "turn_context", payload: { cwd, model: "gpt-5.4" } },
            {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: '[Image: image.png; ref=synthetic] Check reconnect retries [Attached image "image.png" is saved at: /synthetic/image.png]',
                  },
                ],
              },
            },
            { type: "event_msg", payload: { type: "task_complete" } },
          ]);
        } else if (index < 5996)
          await write(join(root, "pi/sessions/project", `${index}.jsonl`), [
            { type: "session", version: 3, id: `pi-${index}`, cwd },
            {
              type: "message",
              id: "ask",
              parentId: null,
              message: { role: "user", content: "Find app version" },
            },
          ]);
        else if (index < 5999)
          await write(join(root, "claude/projects/p", `${index}.jsonl`), [
            {
              type: "user",
              sessionId: `claude-${index}`,
              cwd,
              message: { role: "user", content: "Fix the retry loop" },
            },
          ]);
        else {
          await write(join(root, "opencode/storage/session/p/huge.json"), [
            { id: "huge", directory: cwd, title: "New session" },
          ]);
          await write(join(root, "opencode/storage/message/huge/message.json"), [
            { role: "user", legacy: "x".repeat(180000) },
          ]);
        }
      }),
    );
  service = await openHistory({ indexPath: join(root, "ace/index.sqlite"), instances });
  for (const label of ["cold", "warm"]) {
    const started = performance.now();
    const result = await service.scan();
    console.log(
      JSON.stringify({
        benchmark: `6000-messy-files-${label}`,
        ms: Math.round(performance.now() - started),
        ...result,
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      }),
    );
  }
  console.log(
    JSON.stringify({
      listed: (
        await service.list({ type: "history.list", cwd, limit: 4, openableOnly: true })
      ).sessions.map((s) => s.title),
    }),
  );
} finally {
  await service?.close();
  await rm(root, { recursive: true, force: true });
}
