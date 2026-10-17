import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
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

test("where the thread runs is one row in the strip above the composer; a notice takes its place", async () => {
  const backing = memoryKeyValue();
  let refuse = false;
  const storage = {
    ...backing,
    get length() {
      return backing.data.size;
    },
    setItem(key: string, value: string) {
      if (refuse && key === "ace.composer.drafts") throw new Error("quota");
      backing.setItem(key, value);
    },
  };
  const app = harness({ storage });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const message = await screen.findByRole("combobox", { name: "Message" });
  const where = await screen.findByRole("region", { name: "Where this thread runs" });
  const composer = document.querySelector("[data-slot=composer]");
  // Above the composer's box, not inside it: the box keeps the message and its controls.
  expect(composer?.contains(where)).toBe(false);
  expect(
    composer && where.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(within(where).getByRole("checkbox", { name: "Worktree" })).toBeTruthy();
  // One device: the machine goes without saying.
  expect(within(where).queryByRole("img", { name: /machine icon/ })).toBeNull();

  refuse = true;
  await userEvent.type(message, "Keep this editor open");
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't save");
  expect(screen.queryByRole("region", { name: "Where this thread runs" })).toBeNull();
  // The project stays in reach beside the notice.
  expect(screen.getByRole("button", { name: "Project: relay" })).toBeTruthy();
  expect(textAfterComposer()).toBe("");
});

test("the page is the composer and its strip: no wordmark or heading, the project a strip control", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  const main = screen.getByRole("main");
  expect(within(main).queryByRole("heading", { level: 2 })).toBeNull();
  expect(within(main).queryByText("ace", { exact: true })).toBeNull();
  const project = await screen.findByRole("button", { name: "Project: relay" });
  const composer = document.querySelector("[data-slot=composer]");
  expect(
    composer && project.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("the strip names the machine only while more than one device is connected", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const where = await screen.findByRole("region", { name: "Where this thread runs" });
  expect(await within(where).findByRole("img", { name: /machine icon/ })).toBeTruthy();
});
