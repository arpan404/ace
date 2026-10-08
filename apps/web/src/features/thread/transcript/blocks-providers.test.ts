import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTranslator as claudeTranslator } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { readFixture, replayFixture, type ReplayOptions } from "@ace/adapter-testkit";
import type { ThreadView } from "@ace/protocol";
import { isInlineInteraction, rootRunOf } from "@ace/ui-core";
import { expect, test } from "vitest";
import { blockItems, buildBlocks, type BlockSource } from "./blocks.ts";

/*
 * Real recordings of each provider, replayed through its adapter and the daemon's core, then
 * read as the transcript reads them: however a provider interleaves its words, background
 * tasks, subagents and questions, an ask gets at most one work log (also across the runs the
 * agent starts by itself when background work finishes), and the agent's words between steps
 * stay in that log in the order they were said.
 */

/** The repository's recorded fixtures, found from wherever the runner started. */
function fixturesRoot(): string {
  for (let at = process.cwd(); ; at = dirname(at)) {
    if (existsSync(join(at, "fixtures", "claude"))) return join(at, "fixtures");
    if (dirname(at) === at) throw new Error("no fixtures directory above the working directory");
  }
}
const root = fixturesRoot();

interface Recording {
  provider: string;
  file: string;
  createTranslator: ReplayOptions["createTranslator"];
  coreConfig: ReplayOptions["coreConfig"];
}

const opencode = "opencode/2.0.22/muse-spark-1.3-contributor";
const cursor = "cursor-sdk/1.0.35/composer-2.5";
const recordings: Recording[] = [
  ...["background-shell", "subagent-background", "subagent", "question", "tool-read"].flatMap(
    (name): Recording[] => [
      {
        provider: "claude",
        file: `claude/2.1.286/${name}.jsonl`,
        createTranslator: claudeTranslator,
        coreConfig: { provider: "claude", silenceMs: 60_000 },
      },
      {
        provider: "codex",
        file: `codex/0.159.1/${name}.jsonl`,
        createTranslator: createCodexAdapter().createTranslator,
        coreConfig: { provider: "codex", silenceMs: 90_000 },
      },
      {
        provider: "opencode",
        file: `${opencode}/${name}.jsonl`,
        createTranslator: createOpenCodeAdapter().createTranslator,
        coreConfig: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
      },
    ],
  ),
  ...["background-shell", "background-child", "foreground-child", "plan-question"].map(
    (name): Recording => ({
      provider: "cursor",
      file: `${cursor}/${name}.jsonl`,
      createTranslator: createCursorAdapter().createTranslator,
      coreConfig: { provider: "cursor", silenceMs: 90_000 },
    }),
  ),
];

/** The transcript's source over a replayed thread, as `use-blocks.ts` builds it from a reader. */
function sourceOf(view: ThreadView): BlockSource {
  const reader = {
    order: view.itemOrder,
    thread: view.thread,
    item: (id: string) => view.items[id],
    run: (id: string) => view.runs[id],
    agent: (id: string) => view.agents[id],
  };
  const background = new Map<string, string>();
  for (const task of Object.values(view.backgroundTasks))
    if (task.toolCallId && !task.ambient) background.set(task.toolCallId, task.id);
  return {
    order: view.itemOrder,
    item: reader.item,
    background,
    questions: Object.values(view.interactions)
      .filter(isInlineInteraction)
      .map((interaction) => ({
        id: interaction.id,
        toolCallId: interaction.toolCallId,
        createdAt: interaction.createdAt,
      })),
    turnOf: (id) => rootRunOf(reader, view.items[id]?.runId)?.id,
    run: (id) => view.runs[id],
  };
}

for (const recording of recordings)
  test(`${recording.provider} ${recording.file.split("/").at(-1)}: one work log per turn, the agent's words in order`, async () => {
    const fixture = await readFixture(join(root, recording.file));
    const threads = fixture.threads ? Object.entries(fixture.threads) : [["root", fixture.frames]];
    for (const [threadId, frames] of threads) {
      const { final } = replayFixture({
        fixture: { ...fixture, frames: frames as typeof fixture.frames },
        createTranslator: recording.createTranslator,
        coreConfig: recording.coreConfig,
        ...(fixture.threads ? { threadId: String(threadId) } : {}),
      });
      const source = sourceOf(final.view);
      const blocks = buildBlocks(source);
      // Between two of the person's messages: at most one log, even across the runs the agent
      // started by itself when its background work or a subagent finished.
      let logs = 0;
      for (const block of blocks) {
        if (block.kind === "user") logs = 0;
        if (block.kind === "work") logs++;
        expect(logs).toBeLessThanOrEqual(1);
      }

      // Every assistant message shows exactly once, in the order the agent said them.
      const said = source.order.filter((id) => {
        const item = source.item(id);
        return item?.type === "message" && item.role === "assistant" && !item.synthetic;
      });
      const shown = blocks.flatMap((block) =>
        block.kind === "message" || block.kind === "work"
          ? blockItems(block).filter((id) => said.includes(id))
          : [],
      );
      expect(shown.toSorted()).toEqual(said.toSorted());
      const inWork = blocks.flatMap((block) =>
        block.kind === "work" ? blockItems(block).filter((id) => said.includes(id)) : [],
      );
      expect(inWork).toEqual(said.filter((id) => inWork.includes(id)));
    }
  });
