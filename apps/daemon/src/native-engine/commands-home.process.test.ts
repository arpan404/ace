// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4b's seam tests on a home the TypeScript engine wrote. Each runs only with the switch on,
 * drives the fold hooks through `probe.inputFacts`, and names the (a) test that replaces it:
 *
 * - echo correlation: `late-admission.process` `:15`.
 * - a Claude command's first admission: `catalog-mentions.process` `:10`.
 * - run binding: `queued-run-binding.process` `:101`.
 *
 * The seed is a second process (`testing/inputs-home.ts`), so the real edge is a TypeScript
 * writer and a native reader over the same SQLite file.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { admissions as claudeAdmissions } from "@ace/adapter-claude/input";
import type { ContentPart } from "@ace/protocol";
import { engineBackend } from "@ace/provider-kit/native-switches";
import type { Store } from "../store.ts";
import { engineSeam, type EngineSeam } from "./testing.ts";

const native = engineBackend() === "native";
const child = join(fileURLToPath(new URL(".", import.meta.url)), "testing/inputs-home.ts");

/** The seeded thread, the only one the seed creates. */
function thread(store: Store): string {
  const rows = store.atomic((db) => db.prepare("SELECT id FROM threads ORDER BY rowid").all()) as {
    id: string;
  }[];
  if (rows.length !== 1) throw new Error(`the seed wrote ${String(rows.length)} threads`);
  return rows[0]!.id;
}

async function seeded(): Promise<{ seam: EngineSeam; thread: string }> {
  const seam = await engineSeam({ seedWithTypeScript: { script: child } });
  // E5.4's rounds do not recover threads (E5.8 does): the seam's ready settles its own refusal,
  // and these tests read the home through the probe either way.
  await seam.engine.ready().catch(() => {});
  return { seam, thread: thread(seam.store) };
}

/** One echo of a provider's user message. */
function echo(text: string, item = "native-item", extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    agent: "root",
    item,
    draft: {
      type: "message",
      role: "user",
      parts: [{ type: "text", text }],
      ...extra,
    },
  };
}

describe.runIf(native)("E5.4b input facts on a TypeScript-written home", () => {
  test("an echo correlates natively to the input the TypeScript engine sent: by native identity, by signature in its own generation, and not in another generation", async () => {
    const { seam, thread: id } = await seeded();
    try {
      const identity = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("one", "native-item", { nativeId: "native-one" }),
        generation: 7,
      });
      expect(identity).toMatchObject({
        item: "input:gen-one",
        draft: {
          origin: { kind: "person", commandId: "gen-one" },
          synthetic: false,
        },
      });

      const own = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("two"),
        generation: 8,
      });
      expect(own).toMatchObject({
        item: "input:gen-two",
        draft: { origin: { kind: "person", commandId: "gen-two" }, synthetic: false },
      });

      // The same text in another generation, under an item no echo names: the provider's own.
      const other = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("two", "native-other"),
        generation: 7,
      });
      expect(other).toEqual(echo("two", "native-other"));
    } finally {
      await seam.close();
    }
  });

  test("a Claude input with a slash command correlates by its first admission's text", async () => {
    const { seam, thread: id } = await seeded();
    try {
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
      const first = claudeAdmissions(slash)[0];
      if (typeof first !== "string") throw new Error("the slash command is not one text admission");
      const correlated = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first),
        generation: 7,
      });
      expect(correlated).toMatchObject({
        item: "input:slash",
        draft: { origin: { kind: "person", commandId: "slash" }, synthetic: false },
      });
    } finally {
      await seam.close();
    }
  });

  test("a started run takes the inputs its generation was sent, and no others", async () => {
    const { seam, thread: id } = await seeded();
    try {
      const seventh = seam.probe.inputFacts("bindStartedRun", {
        thread: id,
        run: "run-later",
        generation: 7,
      }) as { item: { runId?: string; parts: { text: string }[] } }[];
      expect(seventh).toHaveLength(1);
      expect(seventh[0]!.item.runId).toBe("run-later");
      expect(seventh[0]!.item.parts.map((part) => part.text)).toEqual(["one"]);

      const eighth = seam.probe.inputFacts("bindStartedRun", {
        thread: id,
        run: "run-later",
        generation: 8,
      }) as { item: { runId?: string; parts: { text: string }[] } }[];
      expect(eighth).toHaveLength(1);
      expect(eighth[0]!.item.runId).toBe("run-later");
      expect(eighth[0]!.item.parts.map((part) => part.text)).toEqual(["two"]);
    } finally {
      await seam.close();
    }
  });
});
