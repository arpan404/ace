import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markitWasmFile } from "@ace/markit-web/assets";
import { MarkitRenderer } from "@ace/markit-web/react";

/*
 * Agent prose streams through the markit ace pins (`@markit/web`, prebuilt from its release). A streaming answer must
 * only grow on screen: markup that is not finished yet (an open backtick, `[text](url` before
 * its `)`, a table header before its delimiter row) used to show as literal characters that
 * were taken back a moment later, which read as the transcript flickering.
 */
const wasm = readFileSync(markitWasmFile());

const answer = `Starting the dedicated thread now. The web-test cleanup just found: \`rm -Rf\` with an empty **\`$TMPDIR\`** would delete from the root, see [the cleanup notes](https://example.com/cleanup).

1. \`scripts/clean.ts\` checks the variable before it deletes *anything*;
2. the sweep skips paths outside \`/tmp/ace-*\`.

| Case | Result |
| --- | --- |
| empty \`TMPDIR\` | refused |

Next I'll run \`bun run test\` and report back in [the thread](ace://thread/thread-1).`;

/** What a reader sees, as text: whitespace runs read as one space, trailing space as nothing. */
const shown = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/g, " ").trimEnd();

/** One streamed update: the text sent so far, what showed, and the code spans drawn. */
interface Update {
  sent: string;
  screen: string;
  code: string[];
}

/** Streams `answer` in uneven chunks, as a provider does; what showed after each, then finished. */
async function stream() {
  const element = document.createElement("div");
  document.body.append(element);
  const renderer = new MarkitRenderer(element, { worker: "inline", wasm, flavor: "agent" });
  const updates: Update[] = [];
  const sizes = [7, 3, 11, 5, 9, 4, 1, 2];
  for (let at = 0, index = 0; at < answer.length; index++) {
    at = Math.min(answer.length, at + (sizes[index % sizes.length] ?? 1));
    const sent = answer.slice(0, at);
    await renderer.render(sent, { finalized: false });
    const code = [...element.querySelectorAll("code")].map((node) => node.textContent ?? "");
    updates.push({ sent, screen: shown(element), code });
  }
  await renderer.render(answer);
  const finished = shown(element);
  renderer.destroy();
  return { updates, finished };
}

/** The first update whose text had come as far as `text`. */
const reached = (updates: Update[], text: string): Update => {
  const update = updates.find(({ sent }) => sent.includes(text));
  if (!update) throw new Error(`The stream never sent ${text}`);
  return update;
};

describe("a streaming answer only grows on screen", () => {
  it("never takes back text it showed while its markup completes", async () => {
    const { updates, finished } = await stream();
    const screens = [...updates.map(({ screen }) => screen), finished];
    const takenBack = screens.flatMap((after, index) => {
      const before = screens[index - 1] ?? "";
      return after.startsWith(before)
        ? []
        : [{ before: before.slice(-40), after: after.slice(-40) }];
    });
    expect(takenBack).toEqual([]);
    expect(finished).toContain("rm -Rf with an empty $TMPDIR would delete");
    expect(finished).toContain("see the cleanup notes.");
  });

  it("shows prose and closed spans while the answer is still streaming", async () => {
    const { updates, finished } = await stream();
    // Plain prose shows as it arrives, before any markup.
    expect(reached(updates, "thread now. The").screen).toContain(
      "Starting the dedicated thread now.",
    );
    // A span shows as code as soon as it closes, long before the answer finishes.
    const closed = reached(updates, "`rm -Rf` with an");
    expect(closed.code).toContain("rm -Rf");
    expect(closed.screen).toContain("just found: rm -Rf with");
    expect(reached(updates, "notes](https://example.com/cleanup).").screen).toContain(
      "see the cleanup notes.",
    );
    // The whole answer is on screen before the stream is marked finished.
    expect(updates.at(-1)?.screen).toBe(finished);
  });
});
