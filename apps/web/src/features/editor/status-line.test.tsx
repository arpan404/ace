import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import { editorStatus, positionText } from "./editor-status.ts";
import type { EditorStatus } from "./editor-status.ts";
import type { EditorHandle } from "./types.ts";

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

function caret(line: number, column: number) {
  return { anchor: { line, column }, head: { line, column } };
}

async function openEditor(text: string, path = "src/a.ts") {
  const ref = createRef<EditorHandle>();
  render(<CodeEditor ref={ref} path={path} label="Editor" text={text} highlightDelay={60_000} />);
  await screen.findByRole("textbox", { name: path.slice(path.lastIndexOf("/") + 1) });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return ref;
}

const status = () => screen.getByRole("contentinfo", { name: "Editor status" });

function positionOf(selections: Parameters<typeof editorStatus>[0]["selections"], primary = 0) {
  return positionText(
    editorStatus({
      selections,
      primary,
      indent: { tabs: false, size: 2 },
      lineEnding: "\n",
      language: undefined,
      languageChosen: false,
      whitespace: false,
      readOnly: false,
    }),
  );
}

test("the position reads Ln and Col, with what is selected", () => {
  expect(positionOf([caret(2, 4)])).toBe("Ln 3, Col 5");
  expect(positionOf([{ anchor: { line: 0, column: 1 }, head: { line: 0, column: 4 } }])).toBe(
    "Ln 1, Col 5 (3 selected)",
  );
  expect(positionOf([{ anchor: { line: 0, column: 0 }, head: { line: 2, column: 0 } }])).toBe(
    "Ln 3, Col 1 (3 lines)",
  );
  expect(positionOf([caret(0, 0), caret(1, 0)], 1)).toBe("Ln 2, Col 1 (2 selections)");
});

test("the status line shows the caret, the detected indent, the line ending, UTF-8 and the language", async () => {
  const ref = await openEditor("a\r\n    b\r\n");
  act(() => ref.current?.setSelections([caret(1, 2)]));
  expect(status().textContent).toContain("Ln 2, Col 3");
  expect(screen.getByRole("button", { name: "Indentation: Spaces: 4" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Line endings: CRLF" })).toBeTruthy();
  expect(status().textContent).toContain("UTF-8");
  expect(screen.getByRole("button", { name: "Language: TypeScript" })).toBeTruthy();
});

test("choosing LF rewrites the line endings as one undoable edit", async () => {
  const ref = await openEditor("a\r\nb");
  await userEvent.click(screen.getByRole("button", { name: "Line endings: CRLF" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "LF" }));
  expect(ref.current?.text()).toBe("a\nb");
  expect(screen.getByRole("button", { name: "Line endings: LF" })).toBeTruthy();
});

test("choosing tabs makes Tab write a tab", async () => {
  const ref = await openEditor("a");
  await userEvent.click(screen.getByRole("button", { name: "Indentation: Spaces: 2" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Tabs" }));
  expect(screen.getByRole("button", { name: "Indentation: Tab Size: 2" })).toBeTruthy();
  act(() => ref.current?.focus());
  act(() => ref.current?.setSelections([caret(0, 0)]));
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).toBe("\ta");
});

test("choosing a language changes what Cmd+/ comments with", async () => {
  const ref = await openEditor("x = 1", "notes.txt");
  expect(screen.getByRole("button", { name: "Language: Plain Text" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Language: Plain Text" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Python" }));
  act(() => ref.current?.focus());
  await userEvent.keyboard("{Meta>}/{/Meta}");
  expect(ref.current?.text()).toBe("# x = 1");
});

test("Show whitespace in the indentation menu draws the marks", async () => {
  await openEditor("a b");
  expect(document.querySelectorAll("[data-whitespace]")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Indentation: Spaces: 2" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show whitespace" }));
  await waitFor(() => expect(document.querySelectorAll("[data-whitespace]")).toHaveLength(1));
});

test("without its own status line, the editor reports its status and takes the setters from outside", async () => {
  const ref = createRef<EditorHandle>();
  const heard: EditorStatus[] = [];
  render(
    <CodeEditor
      ref={ref}
      path="a.ts"
      label="Editor"
      text={"a\r\n    b"}
      statusLine={false}
      onStatus={(reported) => heard.push(reported)}
      highlightDelay={60_000}
    />,
  );
  await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current?.status()).toBeDefined());
  expect(screen.queryByRole("contentinfo", { name: "Editor status" })).toBeNull();
  expect(ref.current?.status()).toMatchObject({
    line: 1,
    column: 1,
    selections: 1,
    indent: { tabs: false, size: 4 },
    lineEnding: "\r\n",
    encoding: "UTF-8",
    language: "ts",
  });

  act(() => ref.current?.setSelections([caret(1, 2), caret(0, 0)]));
  await waitFor(() => expect(heard.at(-1)).toMatchObject({ line: 1, column: 1, selections: 2 }));

  act(() => ref.current?.statusActions().setLineEnding("\n"));
  expect(ref.current?.text()).toBe("a\n    b");
  act(() => ref.current?.statusActions().setLanguage(undefined));
  await waitFor(() =>
    expect(heard.at(-1)).toMatchObject({ language: undefined, languageChosen: true }),
  );
  act(() => ref.current?.statusActions().setIndent({ tabs: true, size: 4 }));
  await waitFor(() => expect(heard.at(-1)?.indent).toEqual({ tabs: true, size: 4 }));
  // The same status twice is told once.
  act(() => ref.current?.setSelections([caret(0, 1)]));
  await waitFor(() => expect(heard.at(-1)).toMatchObject({ column: 2, selections: 1 }));
  const count = heard.length;
  act(() => ref.current?.setSelections([caret(0, 1)]));
  expect(heard).toHaveLength(count);
});
