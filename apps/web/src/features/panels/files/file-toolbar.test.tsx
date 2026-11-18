import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FileToolbar } from "./file-toolbar.tsx";
import type { useFileActions } from "./use-file-actions.ts";

/*
 * The file tab's toolbar: the wrap toggle sits with find and copy, shows whether lines wrap,
 * and only acts on a file that can be read as text.
 */

function actions(): ReturnType<typeof useFileActions> {
  return {
    saving: undefined,
    save: () => Promise.resolve(),
    upload: undefined,
    uploadFiles: () => Promise.resolve(),
    replace: () => undefined,
    dismissUpload: () => undefined,
    editors: [],
    editorUnavailable: undefined,
    editor: undefined,
    openInEditor: () => Promise.resolve(),
    copyPath: () => undefined,
    pathCopied: false,
  };
}

function draw(overrides: { wrap?: boolean; readable?: boolean } = {}) {
  const onWrap = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileToolbar
        project="Checkout"
        path="notes.txt"
        preview={false}
        source={false}
        wrap={overrides.wrap ?? false}
        finding={false}
        treeOpen={false}
        readable={overrides.readable ?? true}
        online
        actions={actions()}
        onFolder={vi.fn()}
        onKeep={vi.fn()}
        onSource={vi.fn()}
        onWrap={onWrap}
        onFind={vi.fn()}
        onTree={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return onWrap;
}

test("the wrap button says what it will do and turns lines on and off", () => {
  const onWrap = draw({ wrap: false });
  const button = screen.getByRole("button", { name: "Wrap lines" });
  expect(button.getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(button);
  expect(onWrap).toHaveBeenCalledTimes(1);
});

test("a wrapping file's button is pressed and offers the way back", () => {
  draw({ wrap: true });
  const button = screen.getByRole("button", { name: "Don't wrap lines" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

test("wrap waits for a file that can be read as text", () => {
  draw({ readable: false });
  const button = screen.getByRole("button", { name: "Wrap lines" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
