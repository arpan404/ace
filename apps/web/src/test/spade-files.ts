import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { editorText } from "./editor-text.ts";

/**
 * A bot's file open in Computer's Files, in its source: Markdown opens rendered, so this picks
 * Source first. Waits for the editor to show `text`, and returns its region and input.
 */
export async function openSource(path: string, text: string) {
  if (/\.(md|markdown)$/i.test(path)) {
    // Wide, Source is a button over the file; in the narrow side panel it is in the header menu.
    const toggle = await waitFor(() => {
      const button = screen.queryByRole("button", { name: "Source" });
      const options = screen.queryByRole("button", { name: "File options" });
      const found = button ?? options;
      if (!found) throw new Error("no way to reach Source yet");
      return found;
    });
    await userEvent.click(toggle);
    if (toggle.getAttribute("aria-label") === "File options")
      await userEvent.click(await screen.findByRole("menuitemradio", { name: "Source" }));
  }
  const region = await screen.findByRole("region", { name: `Source of ${path}` });
  const box = await within(region).findByRole("textbox", { name: path.split("/").at(-1) ?? path });
  await waitFor(() => expect(editorText(region)).toBe(text));
  return { region, box };
}
