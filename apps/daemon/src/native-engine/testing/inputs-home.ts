// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript engine writes the home `commands-home.process.test.ts` reads for E5.4b: one
 * thread whose transcript holds the user messages `input:gen-one` and `input:gen-two`, with
 * journal rows handing them to generations 7 and 8 (no run yet), a native identity for the
 * first, and a Claude slash command's admission text in the journal. No provider CLI and no
 * daemon: a scripted adapter stands in for the provider, the TypeScript `InputJournal` writes the
 * rows, and the parent's native engine reads them through `probe.inputFacts`.
 */
import { join } from "node:path";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { AdapterRegistry, Engine, Store } from "@ace/daemon";
import {
  Capabilities,
  Command,
  CommandId,
  type CommandPayload,
  type ContentPart,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import type { SessionContext } from "@ace/engine-api";
import { InputJournal } from "../../engine/input-journal.ts";
import { ManualClock, end, scriptFrames, start } from "../../engine/test-support.ts";

const home = process.env.ACE_HOME;
if (!home) throw new Error("ACE_HOME is required");

const clock = new ManualClock();
const frames = scriptFrames();
const errors: unknown[] = [];
const store = new Store(join(home, "events.sqlite"));
const workspace = store.createWorkspace(home, "Home");
const registry = new AdapterRegistry();
const engine = new Engine(store, {
  registry,
  clock,
  idleMs: 30_000,
  silenceMs: 30_000,
  onError: (error) => errors.push(error),
});

/** A provider user message the transcript keeps under an input key. */
function userItem(item: string, text: string): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "message",
      role: "user",
      parts: [{ type: "text", text }],
      complete: true,
    },
  };
}

function adapter(contexts: SessionContext[]) {
  const scripted = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: Capabilities.parse({
      steer: false,
      interruptCascades: false,
      resume: true,
      fork: false,
      subagentTranscripts: true,
      backgroundTaskControl: true,
      backgroundVisibility: "full",
      planMode: false,
      tokenUsage: false,
      imageInput: true,
      rewindFiles: false,
    }),
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            userItem("input:gen-one", "one"),
            userItem("input:gen-two", "two"),
            end,
          ),
        ],
      },
    ],
  });
  return {
    ...scripted,
    async openSession(context: SessionContext) {
      contexts.push(context);
      return scripted.openSession(context);
    },
  };
}

function dispatch(payload: CommandPayload, id: string): void {
  const command = Command.parse({ id, deviceId: "device", payload });
  const result = store.recordCommand(command.id, command.deviceId, () =>
    engine.handler.handle(command, store),
  );
  if (!result.ok) throw new Error(result.error);
}

const text = (value: string) => [{ type: "text" as const, text: value }];

try {
  const contexts: SessionContext[] = [];
  registry.register(adapter(contexts), { installed: true, auth: "logged_in", loginHint: "unused" });
  dispatch(
    {
      type: "thread.create",
      workspaceId: workspace,
      provider: "codex",
      model: "model",
      input: text("seed"),
    },
    "seed-create",
  );
  const thread = store.listThreads().at(-1);
  if (!thread) throw new Error("Missing created thread");
  await engine.flush();

  // The sends' journal rows: handed to generations 7 and 8, and no run has taken them.
  const journal = new InputJournal(store);
  for (const [command, generation] of [
    ["gen-one", 7],
    ["gen-two", 8],
  ] as const) {
    const key = `input:${command}`;
    journal.register(thread.id, key, text(command === "gen-one" ? "one" : "two"), {
      kind: "person",
      commandId: CommandId.parse(command),
    });
    journal.sending(
      thread.id,
      key,
      text(command === "gen-one" ? "one" : "two"),
      "codex",
      generation,
    );
  }
  journal.identify(thread.id, { commandId: CommandId.parse("gen-one"), nativeId: "native-one" });

  // A Claude slash command: the journal signs the first admission's text, which is one string.
  const slash: ContentPart[] = [
    {
      type: "mention",
      entryId: "entry",
      kind: "command",
      name: "Review",
      arguments: "now",
      invocation: { type: "slash", name: "review" },
    },
    { type: "text", text: "look" },
  ];
  journal.register(thread.id, "input:slash", slash, {
    kind: "person",
    commandId: CommandId.parse("slash"),
  });
  journal.sending(thread.id, "input:slash", slash, "claude", 7);

  process.stdout.write(`seed ${thread.id}\n`);
  if (errors.length) throw new Error(`engine errors ${JSON.stringify(errors.map(String))}`);
} finally {
  await engine.close().catch(() => {});
  await store.close();
}
