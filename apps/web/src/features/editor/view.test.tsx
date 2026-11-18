import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { CodeEditor, type CodeEditorProps, type EditorHandle } from "./editor.tsx";

/*
 * What the editor draws: colours, the gutter diff, very long lines, virtualization and the
 * accessible surface. The Wasm loads itself in test mode (see `wasm.ts`).
 */

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

async function openView(props: Partial<CodeEditorProps> & { text: string }) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path={props.path ?? "src/example.ts"}
      label={props.label ?? "Source of src/example.ts"}
      highlightDelay={props.highlightDelay ?? 60_000}
      {...props}
    />,
  );
  await screen.findByRole("textbox");
  await waitFor(() => expect(ref.current).toBeTruthy());
  return { ref };
}

const colored = (line: number) =>
  document
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.querySelectorAll('[style*="--source-token-light"]').length ?? 0;

test("TSX source receives distinct syntax colors after asynchronous highlighting", async () => {
  const code = 'export const App = () => <button title="Hello">{42}</button>;';
  await openView({ text: code, path: "app.tsx", readOnly: true, highlightDelay: 0 });

  await waitFor(() => expect(colored(0)).toBeGreaterThan(5));
  const line = document.querySelector('[data-line="0"]');
  expect(line?.textContent).toContain(code);
  const tones = new Set(
    [...(line?.querySelectorAll<HTMLElement>('[style*="--source-token-light"]') ?? [])].map(
      (token) => token.style.getPropertyValue("--source-token-light"),
    ),
  );
  expect(tones.size).toBeGreaterThan(3);
});

test("while text is being edited, untouched lines keep their colours and the edited line shows its new text", async () => {
  const { ref } = await openView({
    text: "export const first = 1;\nexport const second = 2;",
  });
  await waitFor(() => expect(colored(0)).toBeGreaterThan(0));

  const line = "export const second = 2;";
  act(() =>
    ref.current?.setSelections([
      { anchor: { line: 1, column: 0 }, head: { line: 1, column: line.length } },
    ]),
  );
  act(() => ref.current?.focus());
  await userEvent.keyboard("x");

  await waitFor(() =>
    expect(document.querySelector('[data-line="1"]')?.textContent).toContain("x"),
  );
  expect(colored(0)).toBeGreaterThan(0);
  expect(colored(1)).toBe(0);
});

test("a very long line is drawn plain and clipped", async () => {
  const huge = "x".repeat(24_000);
  await openView({ text: `${huge}\nshort`, readOnly: true, highlightDelay: 0 });

  const line = await waitFor(() => {
    const found = document.querySelector<HTMLElement>("[data-long-line]");
    expect(found).toBeTruthy();
    return found;
  });
  const text = line?.querySelector(".whitespace-pre");
  expect(text?.textContent?.length).toBe(20_001);
  expect(text?.textContent?.endsWith("…")).toBe(true);
  expect(line?.querySelectorAll('[style*="--source-token"]').length).toBe(0);
});

test("change marks appear in the gutter after an edit", async () => {
  const { ref } = await openView({ text: "one\ntwo\nthree" });

  act(() =>
    ref.current?.setSelections([{ anchor: { line: 1, column: 0 }, head: { line: 1, column: 3 } }]),
  );
  act(() => ref.current?.focus());
  await userEvent.keyboard("2");

  await waitFor(() =>
    expect(document.querySelector('[data-line="1"]')?.getAttribute("data-mark")).toBe("modified"),
  );
});

test("only the lines near the view are in the DOM for a 50,000-line file", async () => {
  const text = Array.from({ length: 50_000 }, (_, index) => `line ${index}`).join("\n");
  await openView({ text, readOnly: true });

  await waitFor(() => expect(document.querySelectorAll("[data-line]").length).toBeGreaterThan(0));
  const rows = document.querySelectorAll("[data-line]");
  expect(rows.length).toBeLessThan(200);
  expect(document.querySelector('[data-line="0"]')).toBeTruthy();
  expect(document.querySelector('[data-line="49999"]')).toBeNull();
});

test("the textarea names the file, the lines are hidden from assistive tech, and the caret is announced", async () => {
  const { ref } = await openView({
    text: "alpha\nbeta gamma",
    readOnly: true,
    path: "src/hello.ts",
  });
  const box = screen.getByRole("textbox", { name: "hello.ts" });
  const region = screen.getByRole("region", { name: "Source of src/example.ts" });
  expect(within(region).getByText("alpha")).toBeTruthy();
  expect(document.querySelector('[data-line="0"]')?.closest('[aria-hidden="true"]')).toBeTruthy();

  act(() =>
    ref.current?.setSelections([{ anchor: { line: 1, column: 2 }, head: { line: 1, column: 2 } }]),
  );
  await waitFor(() => expect(screen.getByText("Line 2, column 3")).toBeTruthy());
  expect(box.getAttribute("aria-label")).toBe("hello.ts");
});

test("a read-only editor shows the text but takes no keyboard input", async () => {
  const { ref } = await openView({ text: "unchanged", readOnly: true });
  act(() => ref.current?.focus());
  await userEvent.keyboard("typed");
  expect(ref.current?.text()).toBe("unchanged");
});
