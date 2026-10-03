import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { forkClaudeSession } from "./index.ts";

const sourceId = "a2465c19-f2ce-4c26-a47c-7d46b7d9f3e";
const firstId = "9d6d901c-47da-48c8-a2d5-24e3786221a1";
const lastId = "767fa44a-3d99-4332-a3e3-0c7b65c6a6ca";
async function transcript(home: string, text: string) {
  const project = join(home, ".claude", "projects", "-synthetic-project");
  await mkdir(project, { recursive: true });
  const bytes =
    [
      {
        type: "user",
        uuid: firstId,
        parentUuid: null,
        sessionId: sourceId,
        cwd: "/synthetic/project",
        isSidechain: false,
        timestamp: "2026-10-02T12:00:00Z",
        message: { role: "user", content: text },
      },
      {
        type: "assistant",
        uuid: lastId,
        parentUuid: firstId,
        sessionId: sourceId,
        cwd: "/synthetic/project",
        isSidechain: false,
        timestamp: "2026-10-02T12:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  const file = join(project, `${sourceId}.jsonl`);
  await writeFile(file, bytes);
  return { project, file, bytes };
}

test("idle Claude forks keep equal source ids in separate homes isolated and leave both source transcripts unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-fork-"));
  const homes = [join(root, "one"), join(root, "two")];
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    const sources = await Promise.all(
      homes.map((home, index) => transcript(home, `private-${index}`)),
    );
    const forks = await Promise.all(
      homes.map((home) =>
        forkClaudeSession({
          nativeSessionId: sourceId,
          home,
          signal: new AbortController().signal,
        }),
      ),
    );
    expect(new Set([sourceId, ...forks]).size).toBe(3);
    for (const [index, source] of sources.entries()) {
      const native = forks[index];
      if (!native) throw new Error("Missing fork identity");
      expect(await readFile(source.file, "utf8")).toBe(source.bytes);
      expect(await readdir(source.project)).toContain(`${native}.jsonl`);
      const bytes = await readFile(join(source.project, `${native}.jsonl`), "utf8");
      expect(bytes).toContain(`private-${index}`);
      expect(bytes).not.toContain(`private-${1 - index}`);
      const entries = bytes
        .trim()
        .split("\n")
        .map((line) =>
          z
            .object({
              type: z.string(),
              uuid: z.string().optional(),
              parentUuid: z.string().nullable().optional(),
            })
            .passthrough()
            .parse(JSON.parse(line)),
        );
      const user = entries.find((entry) => entry.type === "user");
      const assistant = entries.find((entry) => entry.type === "assistant");
      expect(user?.uuid).not.toBe(firstId);
      expect(assistant?.uuid).not.toBe(lastId);
      expect(assistant?.parentUuid).toBe(user?.uuid);
    }
    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(previousConfigDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
