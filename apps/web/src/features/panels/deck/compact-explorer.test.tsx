import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ScopeWorkspace } from "@ace/ui-core/workspace-tabs";
import { findInDeck, type DeckTarget, type WorkspaceActions } from "@/lib/workspace/index.ts";
import { useCompactExplorer } from "./compact-explorer.ts";

/*
 * A compact Deck lays its explorer over the editor only while asked: "Show files", or an opener
 * that needs the person to pick among files (a mention whose name several files share).
 */

const empty: ScopeWorkspace = {
  tabs: [],
  active: undefined,
  open: false,
  size: 600,
  expanded: false,
};

function deckTarget(scope: string): DeckTarget {
  const actions: Partial<WorkspaceActions> = { open: () => {}, setSize: () => {} };
  return { scope, read: () => empty, actions: actions as WorkspaceActions };
}

const compactWidth = 500;

test("a mention several files share lays the explorer over a compact Deck", () => {
  const view = renderHook(() => useCompactExplorer("t-shown", compactWidth, false));
  expect(view.result.current.shown).toBe(false);

  act(() => findInDeck(deckTarget("t-shown"), "index.ts"));
  expect(view.result.current.shown).toBe(true);

  // Hidden again and asked again for the same name, it shows again.
  act(() => view.result.current.setShown(false));
  act(() => findInDeck(deckTarget("t-shown"), "index.ts"));
  expect(view.result.current.shown).toBe(true);
});

test("a Deck that mounts after the mention still shows the explorer once it has measured", () => {
  findInDeck(deckTarget("t-later"), "index.ts");
  const view = renderHook(({ width }) => useCompactExplorer("t-later", width, false), {
    initialProps: { width: 0 },
  });
  view.rerender({ width: compactWidth });
  expect(view.result.current.shown).toBe(true);
});

test("a wide Deck takes the ask, so narrowing it later leaves the overlay closed", () => {
  const view = renderHook(({ width }) => useCompactExplorer("t-wide", width, false), {
    initialProps: { width: 1000 },
  });
  act(() => findInDeck(deckTarget("t-wide"), "index.ts"));
  view.rerender({ width: compactWidth });
  expect(view.result.current.shown).toBe(false);
});
