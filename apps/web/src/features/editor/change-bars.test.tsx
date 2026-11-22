import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import type { LineMark } from "@ace/ui-core";
import { CodeEditor } from "./editor.tsx";
import type { CodeEditorProps, EditorHandle } from "./types.ts";

/*
 * The gutter's change marks and the overview ruler, as the editor draws them for its caller's
 * marks: who changed a line is said in words, never by colour alone.
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

const text = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");

async function open(props: Partial<CodeEditorProps>) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      text={text}
      path="src/example.ts"
      label="Source of src/example.ts"
      highlightDelay={60_000}
      {...props}
    />,
  );
  await screen.findByRole("textbox");
  return { ref };
}

const bar = (line: number) => document.querySelector<HTMLElement>(`[data-change-line="${line}"]`);

test("added, changed and removed lines each carry their mark and say what it is", async () => {
  const marks = new Map<number, LineMark>([
    [1, "added"],
    [2, "modified"],
    [4, "removed"],
  ]);
  await open({ marks });
  await waitFor(() => expect(bar(1)).toBeTruthy());
  expect(bar(1)?.getAttribute("data-change-bar")).toBe("added");
  expect(bar(1)?.title).toBe("Added since the last commit");
  expect(bar(2)?.title).toBe("Changed since the last commit");
  expect(bar(4)?.getAttribute("data-change-bar")).toBe("removed");
  expect(bar(3)).toBeNull();
});

test("lines an agent wrote show its mark and name it and the turn on hover", async () => {
  await open({
    marks: new Map([[2, "modified"]]),
    agentMarks: [
      { start: 1, end: 3, label: "Claude Code changed this in turn 2", provider: "claude" },
    ],
  });
  await waitFor(() => expect(bar(2)).toBeTruthy());
  // The agent's lines read as the agent's, over the commit's own mark.
  expect(bar(2)?.getAttribute("data-change-bar")).toBe("agent");
  expect(bar(3)?.title).toBe("Claude Code changed this in turn 2");
  const who = document.querySelectorAll("[data-agent-mark]");
  expect(who).toHaveLength(1);
  expect(who[0]?.getAttribute("title")).toBe("Claude Code changed this in turn 2");
});

test("a press on a change's tick in the overview ruler brings its line into view", async () => {
  await open({ marks: new Map([[300, "modified"]]) });
  const tick = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-overview-tick="modified"]');
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  expect(tick.title).toBe("Changed since the last commit, line 300");
  fireEvent.pointerDown(tick);
  const scroller = document.querySelector<HTMLElement>("[data-editor-scroller]");
  expect(scroller?.scrollTop).toBeGreaterThan(200 * 22);
});
