import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { editorText } from "./editor-text.ts";

/**
 * A bot's file open in Computer's Files, in its source: Markdown opens rendered, so this picks
 * Source first. Waits for the editor to show `text`, and returns its region and input.
 */
export async function openSource(path: string, text: string) {
  if (/\.(md|markdown)$/i.test(path))
    await userEvent.click(await screen.findByRole("button", { name: "Source" }));
  const region = await screen.findByRole("region", { name: `Source of ${path}` });
  const box = await within(region).findByRole("textbox", { name: path.split("/").at(-1) ?? path });
  await waitFor(() => expect(editorText(region)).toBe(text));
  return { region, box };
}
