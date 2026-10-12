import { workbench } from "@ace/fake-daemon";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

/** Every word on the page that follows the composer in reading order. */
function textAfterComposer(): string {
  const composer = document.querySelector("[data-slot=composer]");
  if (!composer) throw new Error("no composer");
  const walker = document.createTreeWalker(screen.getByRole("main"), NodeFilter.SHOW_TEXT);
  let after = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (
      !composer.contains(node) &&
      composer.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    )
      after += node.textContent ?? "";
  }
  return after.trim();
}

test("nothing renders below the New thread composer, even its save warning", async () => {
  const backing = memoryKeyValue();
  const storage = {
    ...backing,
    get length() {
      return backing.data.size;
    },
    setItem(key: string, value: string) {
      if (key === "ace.composer.drafts") throw new Error("quota");
      backing.setItem(key, value);
    },
  };
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const message = await screen.findByRole("combobox", { name: "Message" });
  expect(textAfterComposer()).toBe("");
  await userEvent.type(message, "Keep this editor open");
  const warning = await screen.findByRole("alert");
  expect(warning.textContent).toContain("Couldn't save this preparation");
  // The warning sits in the strip's place above the composer.
  const composer = document.querySelector("[data-slot=composer]");
  expect(
    composer && warning.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(textAfterComposer()).toBe("");
});
