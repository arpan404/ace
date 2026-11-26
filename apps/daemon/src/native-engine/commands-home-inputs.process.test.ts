// SPDX-License-Identifier: Apache-2.0
/**
 * E5.4b's and E5.4c's seam tests on homes the TypeScript engine wrote. Each runs only with the
 * switch on and names the (a) test that replaces it.
 *
 * E5.4b's journal and run binding (`testing/inputs-home.ts`):
 *
 * - echo correlation: `late-admission.process` `:15`.
 * - a Claude command's first admission, and the Rust signature of it: `catalog-mentions.process`
 *   `:10`.
 * - run binding: `queued-run-binding.process` `:101`.
 *
 * E5.4c's input fate (`testing/commands-home.ts`'s fate thread):
 *
 * - `inputFate`'s precedence: `input-fate.process` `:8`, `:38`, `:66`, `:115`.
 *
 * The seed is a second process, so the real edge is a TypeScript writer and a native reader over
 * the same SQLite file.
 */
import { describe, expect, test } from "vitest";
import { admissions as claudeAdmissions } from "@ace/adapter-claude/input";
import { CommandId, type ContentPart } from "@ace/protocol";
import { echo, native, seeded, seededInputs } from "./testing/commands-home-support.ts";

describe.runIf(native)("E5.4b input facts on a TypeScript-written home", () => {
  test("an echo correlates natively to the input the TypeScript engine sent: by native identity, by signature in its own generation, and not in another generation", async () => {
    const { seam, thread: id } = await seededInputs();
    try {
      // The negative case first: nothing is matched yet, so a miss is a real miss.
      const other = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo("two", "native-other"),
        generation: 7,
      });
      expect(other).toEqual(echo("two", "native-other"));

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
    } finally {
      await seam.close();
    }
  });

  test("a Claude input with a slash command correlates by its first admission's text", async () => {
    const { seam, thread: id } = await seededInputs();
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

  test("a Claude command signed through the Rust journal correlates with its own echo", async () => {
    const { seam, thread: id } = await seededInputs();
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
      // The seed signed `input:slash` in TypeScript; the Rust `sending` signs the same parts.
      seam.probe.inputFacts("inputs.sending", {
        thread: id,
        key: "input:rust-slash",
        parts: slash,
        provider: "claude",
        generation: 7,
      });
      const first = claudeAdmissions(slash)[0];
      if (typeof first !== "string") throw new Error("the slash command is not one text admission");
      const ts = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first, "native-ts"),
        generation: 7,
      });
      expect(ts).toMatchObject({ item: "input:slash" });
      // The next echo of the same text can only match the Rust-signed row.
      const rust = seam.probe.inputFacts("inputs.correlate", {
        thread: id,
        fact: echo(first, "native-rust"),
        generation: 7,
      });
      expect(rust).toMatchObject({
        item: "input:rust-slash",
        draft: { origin: { kind: "person", commandId: "slash" }, synthetic: false },
      });
    } finally {
      await seam.close();
    }
  });

  test("a started run takes the inputs its generation was sent, and no others", async () => {
    const { seam, thread: id } = await seededInputs();
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

describe.runIf(native)("E5.4c input fate on a TypeScript-written home", () => {
  test("inputFate follows its precedence on a TypeScript-written home", async () => {
    const { seam, fate } = await seeded();
    try {
      const at = (command: string) =>
        seam.engine.inputFate(fate as never, CommandId.parse(command));
      // Replaced wins over the uncertain intent the person sent again.
      expect(at("resent")).toEqual({ state: "replaced", by: CommandId.parse("again") });
      // An uncertain input is uncertain before it is waiting.
      expect(at("uncertain-fate")).toEqual({ state: "uncertain" });
      // Waiting wins over the run the journal recorded for it.
      expect(at("waiting-fate")).toEqual({ state: "waiting" });
      // A written input the journal handed to a run: the run comes back, so the read above is
      // a real waiting answer and not a missing run.
      expect(at("delivered-fate")).toEqual({ state: "delivered", runId: "run-recorded" });
      // Written before a Stop cancelled it: failed, not delivered.
      expect(at("cancelled-fate")).toEqual({
        state: "failed",
        error: "Cancelled before delivery",
      });
      expect(at("removed-fate")).toEqual({ state: "removed" });
      // In the transcript with no intent at all.
      expect(at("written")).toEqual({ state: "delivered" });
      expect(at("never-sent")).toEqual({ state: "unknown" });
    } finally {
      await seam.close();
    }
  });
});

/** A command the facade's handler takes. */
