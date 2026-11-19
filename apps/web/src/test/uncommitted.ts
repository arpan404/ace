import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { outboxDiff, replayTs } from "@ace/fake-daemon";

/*
 * Test support for the Changes tab's Uncommitted scope, where review comments go: a git patch
 * for the fake daemon's working tree, and picking the scope.
 */

const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * `after` against `before` as git would print it for one file: a single hunk over the whole
 * file, so every line shows with its number (a longest-common-subsequence line diff).
 */
export function wholeFilePatch(path: string, before: string, after: string): string {
  const old = linesOf(before);
  const next = linesOf(after);
  const width = next.length + 1;
  const common = new Int32Array((old.length + 1) * width);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      common[i * width + j] =
        old[i] === next[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const body: string[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      body.push(` ${old[i]}`);
      i++;
      j++;
    } else if (j < next.length && (i >= old.length || at(i, j + 1) >= at(i + 1, j))) {
      body.push(`+${next[j]}`);
      j++;
    } else {
      body.push(`-${old[i]}`);
      i++;
    }
  }
  const head = old.length
    ? [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`]
    : [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null"];
  return [
    ...head,
    `+++ b/${path}`,
    `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`,
    ...body,
    "",
  ].join("\n");
}

/**
 * The cold-start thread's checkout after turn 2, uncommitted: the server's replay file and the
 * relay outbox, with the same lines the fake daemon's checkout holds.
 */
export const coldStartUncommitted = [
  wholeFilePatch(replayTs.path, replayTs.original, replayTs.afterTurn2).replace(/\n$/, ""),
  `diff --git a/${outboxDiff.path} b/${outboxDiff.path}`,
  "index 3333333..4444444 100644",
  outboxDiff.diff,
].join("\n");

/** Pick Uncommitted in the panel's Changes tab and wait for its diff. */
export async function showUncommitted(panel: HTMLElement): Promise<HTMLElement> {
  const scope = await within(panel).findByRole("button", { name: /^Scope:/ });
  if (!scope.getAttribute("aria-label")?.endsWith("Uncommitted")) {
    await userEvent.click(scope);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Uncommitted/ }));
  }
  let diff: HTMLElement | undefined;
  await waitFor(() => {
    diff = within(panel).getByRole("region", { name: "Uncommitted diff" });
  });
  if (!diff) throw new Error("No Uncommitted diff");
  return diff;
}
