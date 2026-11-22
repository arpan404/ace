// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OutlineSort, OutlineSymbol } from "@ace/ui-core/editor-workbench";
import {
  createStatusStore,
  type StatusReport,
  type TextBuffer,
} from "@/features/editor-workbench/index.ts";
import { Breadcrumbs } from "@/features/editor-workbench/view/breadcrumbs.tsx";
import { EditorOutline } from "./editor-outline.tsx";
import { GoToSymbolDialog } from "./go-to-symbol.tsx";
import { editorKeys } from "./editor-keys.ts";

afterEach(cleanup);

function fakeBuffer(path: string, text: string): TextBuffer {
  const doc = {
    contentId: () => 1,
    text: () => text,
  };
  return {
    key: { root: "thread-1", path },
    document: () => doc as unknown as ReturnType<TextBuffer["document"]>,
    view: () => undefined,
    snapshot: () => ({
      path,
      status: { kind: "ready" },
      dirty: false,
      saving: false,
      clash: undefined,
      draftKept: false,
      manualSave: false,
      version: "v1",
    }),
    baseText: () => text,
    subscribe: () => () => {},
    edited: () => {},
    editLines: () => false,
    save: async () => ({ kind: "saved", version: "v1" }),
    replace: async () => ({ kind: "saved", version: "v1" }),
    merge: async () => {},
    keepMine: async () => {},
    takeTheirs: async () => {},
    answer: async () => {},
    answerAll: async () => {},
    discard: async () => {},
    saveStamp: () => undefined,
    reload: async () => {},
  };
}

function reportAt(line: number, language = "typescript"): StatusReport {
  return {
    status: {
      line,
      column: 1,
      selections: 1,
      selectedCharacters: 0,
      selectedLines: 0,
      indent: { tabs: false, size: 2 },
      lineEnding: "\n",
      encoding: "UTF-8",
      language,
      languageChosen: false,
      whitespace: false,
      readOnly: false,
    },
    actions: {
      setIndent: () => {},
      setLineEnding: () => {},
      setLanguage: () => {},
      setWhitespace: () => {},
    },
  };
}

const sampleSource = [
  "export class ZebraController {",
  "  closeTab(id: string) {",
  "    return id;",
  "  }",
  "  activateTab(id: string) {",
  "    return id;",
  "  }",
  "}",
  "",
  "export function alphaHelper() {",
  "  return 1;",
  "}",
].join("\n");

describe("EditorOutline", () => {
  test("lists symbols, highlights the symbol at the caret, clicks to reveal, filters, and sorts", async () => {
    const buffer = fakeBuffer("src/workspace-tabs.ts", sampleSource);
    const status = createStatusStore();
    status.report("g1", reportAt(3));
    const revealed: OutlineSymbol[] = [];
    let sort: OutlineSort = "position";

    const view = render(
      <EditorOutline
        path="src/workspace-tabs.ts"
        buffer={buffer}
        focusedGroupId="g1"
        statusStore={status}
        open
        onOpenChange={() => {}}
        sort={sort}
        onSortChange={(next) => {
          sort = next;
        }}
        onReveal={(sym) => revealed.push(sym)}
      />,
    );

    const closeBtn = await screen.findByRole("button", { name: /closeTab/ });
    expect(closeBtn.getAttribute("aria-current")).toBe("true");

    // Moving the caret into alphaHelper updates the active highlight without remounting.
    act(() => status.report("g1", reportAt(11)));
    const alphaBtn = screen.getByRole("button", { name: /alphaHelper/ });
    expect(alphaBtn.getAttribute("aria-current")).toBe("true");
    expect(closeBtn.getAttribute("aria-current")).toBeNull();

    // Clicking a symbol reveals it at its line and column.
    fireEvent.click(closeBtn);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toMatchObject({ name: "closeTab", line: 2 });

    // Sorting by name moves alphaHelper before ZebraController.
    fireEvent.click(screen.getByRole("button", { name: "Sort by name" }));
    expect(sort).toBe("name");
    view.rerender(
      <EditorOutline
        path="src/workspace-tabs.ts"
        buffer={buffer}
        focusedGroupId="g1"
        statusStore={status}
        open
        onOpenChange={() => {}}
        sort={sort}
        onSortChange={(next) => {
          sort = next;
        }}
        onReveal={(sym) => revealed.push(sym)}
      />,
    );
    const items = screen.getAllByRole("treeitem");
    expect(items[0]?.textContent).toContain("alphaHelper");

    // Filtering by typing narrows the visible tree while keeping enclosing containers.
    fireEvent.click(screen.getByRole("button", { name: "Filter symbols" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter symbols" }), {
      target: { value: "activate" },
    });
    expect(screen.getByRole("button", { name: /activateTab/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /alphaHelper/ })).toBeNull();
  });
});

describe("Breadcrumbs symbol trail and GoToSymbolDialog", () => {
  test("Breadcrumbs appends the symbol trail at the caret line and reveals on click", () => {
    const symbols: OutlineSymbol[] = [
      {
        name: "ZebraController",
        kind: "class",
        line: 1,
        column: 14,
        endLine: 8,
        children: [
          {
            name: "closeTab",
            kind: "method",
            line: 2,
            column: 3,
            endLine: 4,
            children: [],
          },
        ],
      },
    ];
    const onReveal = vi.fn();
    render(
      <Breadcrumbs
        path="apps/web/src/workspace-tabs.ts"
        symbols={symbols}
        caretLine={3}
        onRevealSymbol={onReveal}
      />,
    );

    expect(screen.getByText("workspace-tabs.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ZebraController/ })).toBeTruthy();
    const leaf = screen.getByRole("button", { name: /closeTab/ });
    expect(leaf.getAttribute("aria-current")).toBe("location");
    fireEvent.click(leaf);
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ name: "closeTab", line: 2 }));
  });

  test("GoToSymbolDialog filters by query and picks the matched symbol on Enter", async () => {
    const symbols: OutlineSymbol[] = [
      { name: "openTab", kind: "function", line: 1, column: 1, endLine: 5, children: [] },
      { name: "closeTab", kind: "function", line: 7, column: 1, endLine: 12, children: [] },
    ];
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <GoToSymbolDialog
        path="src/workspace-tabs.ts"
        symbols={symbols}
        onPick={onPick}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Go to symbol" });
    fireEvent.change(input, { target: { value: "close" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "closeTab", line: 7 }));
    });
  });

  test("⇧⌘O maps to goToSymbol in editorKeys", () => {
    const keys = editorKeys({ apple: true, web: false });
    const event = new KeyboardEvent("keydown", { key: "o", metaKey: true, shiftKey: true });
    expect(keys.press(event)).toBe("goToSymbol");
  });
});
