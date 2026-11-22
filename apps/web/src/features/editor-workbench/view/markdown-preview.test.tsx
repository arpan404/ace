import { screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, test } from "vitest";
import { ready } from "../buffers/test-support.ts";
import { group, mountEditor, tab } from "./editor-test-support.tsx";

/*
 * A Markdown file shows rendered by default (spec 40): its text is on screen, and the status
 * line still speaks for the file while the preview has focus.
 */

beforeAll(ready);

const statusLine = () => document.querySelector('[data-part="editor-status"]');

test("README.md on Preview shows its text and the status line names the file's language", async () => {
  await mountEditor({ root: group("g0", [tab("README.md")]), focused: "g0" });

  await waitFor(() => expect(screen.getByText(/line two/)).toBeTruthy());
  expect(screen.getByText("Preview")).toBeTruthy();
  await waitFor(() => expect(statusLine()?.textContent).toContain("Markdown"));
});
