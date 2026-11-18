import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CodeEditor } from "./editor.tsx";

/* The editor's Wasm is the one thing that can fail before a document exists. */

const ensureEditorReady = vi.hoisted(() =>
  vi.fn(() => Promise.reject(new Error("no WebAssembly here"))),
);
vi.mock("./wasm.ts", () => ({ ensureEditorReady }));

test("a Wasm that cannot load shows an error with a retry", async () => {
  render(<CodeEditor text="hello" path="a.ts" label="Editor" />);

  expect((await screen.findByRole("alert")).textContent).toContain("The editor couldn't start");
  const retry = screen.getByRole("button", { name: "Try again" });
  const attempts = ensureEditorReady.mock.calls.length;
  await userEvent.click(retry);
  expect(ensureEditorReady.mock.calls.length).toBeGreaterThan(attempts);
  expect((await screen.findByRole("alert")).textContent).toContain("The editor couldn't start");
});
