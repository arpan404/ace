import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarkitRenderer } from "@ace/markit-web/react";

/*
 * Agent prose streams through the markit pinned in `packages/markit`. A streaming answer must
 * only grow on screen: markup that is not finished yet (an open backtick, `[text](url` before
 * its `)`, a table header before its delimiter row) used to show as literal characters that
 * were taken back a moment later, which read as the transcript flickering.
 */
const wasm = readFileSync(
  join(import.meta.dirname, "../../../../../packages/markit/web/pkg/markit_wasm_bg.wasm"),
);

const answer = `Starting the dedicated thread now. The web-test cleanup just found: \`rm -Rf\` with an empty **\`$TMPDIR\`** would delete from the root, see [the cleanup notes](https://example.com/cleanup).

1. \`scripts/clean.ts\` checks the variable before it deletes *anything*;
2. the sweep skips paths outside \`/tmp/ace-*\`.

| Case | Result |
| --- | --- |
| empty \`TMPDIR\` | refused |

Next I'll run \`bun run test\` and report back in [the thread](ace://thread/thread-1).`;

/** What a reader sees, as text: whitespace runs read as one space, trailing space as nothing. */
const shown = (element: HTMLElement) => (element.textContent ?? "").replace(/\s+/g, " ").trimEnd();

describe("a streaming answer only grows on screen", () => {
  it("never takes back text it showed while its markup completes", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const renderer = new MarkitRenderer(element, { worker: "inline", wasm, flavor: "agent" });
    const screens: string[] = [];
    // Uneven chunks, as a provider streams them.
    const sizes = [7, 3, 11, 5, 9, 4, 1, 2];
    for (let at = 0, index = 0; at < answer.length; index++) {
      at = Math.min(answer.length, at + (sizes[index % sizes.length] ?? 1));
      await renderer.render(answer.slice(0, at), { finalized: false });
      screens.push(shown(element));
    }
    await renderer.render(answer);
    screens.push(shown(element));
    renderer.destroy();
    const takenBack = screens.flatMap((after, index) => {
      const before = screens[index - 1] ?? "";
      return after.startsWith(before)
        ? []
        : [{ before: before.slice(-40), after: after.slice(-40) }];
    });
    expect(takenBack).toEqual([]);
    expect(screens.at(-1)).toContain("rm -Rf with an empty $TMPDIR would delete");
    expect(screens.at(-1)).toContain("see the cleanup notes.");
  });
});
