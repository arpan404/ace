import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, expect, test } from "vitest";
import { CodeEditor } from "./editor.tsx";
import type { EditorHandle } from "./types.ts";

/*
 * Tab never traps the keyboard in the editor: VS Code's Tab-moves-focus mode (Ctrl+M, Ctrl+Shift+M
 * on macOS) shown on the status line, and Escape then Tab to leave once.
 */

function platform(name: string) {
  Object.defineProperty(navigator, "platform", { value: name, configurable: true });
}

async function openEditor(text: string) {
  const ref = createRef<EditorHandle>();
  render(
    <CodeEditor
      ref={ref}
      path="src/a.ts"
      label="Editor"
      text={text}
      commitAfter={20}
      highlightDelay={60_000}
    />,
  );
  const field = await screen.findByRole("textbox", { name: "a.ts" });
  await waitFor(() => expect(ref.current).toBeTruthy());
  act(() => ref.current?.focus());
  return { ref, field };
}

const status = () => screen.getByRole("contentinfo", { name: "Editor status" });
/** Focus went on past the editor (to its status line's first control, or what follows). */
const left = (field: HTMLElement) =>
  document.activeElement !== field && document.activeElement !== document.body;

afterEach(async () => {
  // The mode is the window's, as VS Code's is: turn it off for the next test.
  const shown = screen.queryByRole("button", { name: /Tab moves focus/ });
  if (shown) await userEvent.click(shown);
});

test("Ctrl+Shift+M on macOS makes Tab move focus on, says so, and toggles back", async () => {
  platform("MacIntel");
  const { ref, field } = await openEditor("x");
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  expect(within(status()).getByRole("button", { name: /Tab moves focus/ })).toBeTruthy();
  await userEvent.keyboard("{Tab}");
  expect(left(field)).toBe(true);
  expect(ref.current?.text()).toBe("x");

  field.focus();
  await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
  expect(within(status()).queryByRole("button", { name: /Tab moves focus/ })).toBeNull();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(field);
  expect(ref.current?.text()).not.toBe("x");
});

test("Ctrl+M toggles it off macOS, and the status line's word turns it off", async () => {
  platform("Win32");
  const { ref, field } = await openEditor("x");
  await userEvent.keyboard("{Control>}m{/Control}");
  await userEvent.keyboard("{Tab}");
  expect(left(field)).toBe(true);
  await userEvent.click(within(status()).getByRole("button", { name: /Tab moves focus/ }));
  act(() => ref.current?.focus());
  await userEvent.keyboard("{Tab}");
  expect(ref.current?.text()).not.toBe("x");
});

test("Escape then Tab leaves the editor once; Tab after coming back indents again", async () => {
  platform("MacIntel");
  const { ref, field } = await openEditor("x");
  await userEvent.keyboard("{Escape}{Tab}");
  expect(left(field)).toBe(true);
  expect(ref.current?.text()).toBe("x");
  field.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(field);
  expect(ref.current?.text()).not.toBe("x");
});
