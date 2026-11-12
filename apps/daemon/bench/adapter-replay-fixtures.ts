/**
 * The recorded provider sessions the adapter replay bench feeds through each real translator.
 * ACP and Pi have no recorded sessions (fixtures/acp holds only a schema, fixtures/pi a README),
 * so they are not here; recording them would spend provider quota.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator as createClaudeTranslator } from "@ace/adapter-claude";
import { createCodexAdapter } from "@ace/adapter-codex";
import { createCursorAdapter } from "@ace/adapter-cursor";
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
import { readFixture } from "@ace/adapter-testkit";
import type { Frame, ProviderAdapter } from "@ace/engine-api";
import type { ProviderKind } from "@ace/protocol";

export interface ReplayProvider {
  provider: ProviderKind;
  directory: string;
  silenceMs: number;
  createTranslator: ProviderAdapter["createTranslator"];
}

const root = new URL("../../../fixtures/", import.meta.url);
const at = (path: string) => fileURLToPath(new URL(path, root));

export const replayProviders: Record<string, ReplayProvider> = {
  claude: {
    provider: "claude",
    directory: at("claude/2.1.286/"),
    silenceMs: 60_000,
    createTranslator: createClaudeTranslator,
  },
  codex: {
    provider: "codex",
    directory: at("codex/0.159.1/"),
    silenceMs: 90_000,
    createTranslator: createCodexAdapter().createTranslator,
  },
  cursor: {
    provider: "cursor",
    directory: at("cursor-sdk/1.0.35/composer-2.5/"),
    silenceMs: 90_000,
    createTranslator: createCursorAdapter().createTranslator,
  },
  opencode: {
    provider: "opencode",
    directory: at("opencode/2.0.22/muse-spark-1.3-contributor/"),
    silenceMs: 25_000,
    createTranslator: createOpenCodeAdapter().createTranslator,
  },
};

/** One recorded frame as it reached the daemon: its wire JSON, ready to admit. */
export interface RecordedFrame {
  t: number;
  dir: Frame["dir"];
  channel: string;
  wire: string;
}

const wire = (frames: readonly Frame[]): RecordedFrame[] =>
  frames.map((frame) => ({
    t: frame.t,
    dir: frame.dir,
    channel: frame.channel,
    wire: JSON.stringify(frame.data),
  }));

/**
 * One replay session per recorded stream. A Cursor SDK capture can hold independent threads
 * (portable-fork holds a source and its fork); each is its own session with its own translator,
 * named `<fixture>#<thread>`, as a live daemon runs them.
 */
export async function recordedSessions(
  provider: ReplayProvider,
): Promise<{ name: string; frames: RecordedFrame[] }[]> {
  const names = readdirSync(provider.directory)
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted();
  const sessions = [];
  for (const name of names) {
    const fixture = await readFixture(`${provider.directory}${name}`);
    const threads = Object.entries(fixture.threads ?? {}).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    if (!threads.length) {
      sessions.push({ name, frames: wire(fixture.frames) });
      continue;
    }
    const split = threads.reduce((total, [, frames]) => total + frames.length, 0);
    if (split !== fixture.frames.length)
      throw new Error(`${name}: ${fixture.frames.length - split} frames belong to no thread`);
    for (const [threadId, frames] of threads)
      sessions.push({ name: `${name}#${threadId}`, frames: wire(frames) });
  }
  return sessions;
}
