import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
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

test("without open work nothing renders below the New thread composer, even its save warning", async () => {
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

test("the page asks what to build in the project, and the project's name picks another", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  const main = screen.getByRole("main");
  const question = within(main).getByRole("heading", { level: 2 });
  expect(question.textContent).toBe("What should we build in relay?");
  expect(within(main).queryByText("ace", { exact: true })).toBeNull();
  const composer = document.querySelector("[data-slot=composer]");
  expect(
    composer && question.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(within(question).getByRole("button", { name: "Project: relay" }));
  const popup = await screen.findByRole("dialog", { name: "Choose project" });
  await userEvent.type(
    await within(popup).findByRole("combobox", { name: "Search projects" }),
    "billing{Enter}",
  );
  await waitFor(() =>
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 2 }).textContent).toBe(
      "What should we build in billing-api?",
    ),
  );
});

test("the machine is named under the question only while more than one device is connected", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const machine = await screen.findByRole("button", { name: "Machine: This Mac" });
  const question = within(screen.getByRole("main")).getByRole("heading", { level: 2 });
  const composer = document.querySelector("[data-slot=composer]");
  // Between the question and the composer, and not in the composer's strip.
  expect(question.compareDocumentPosition(machine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    composer && machine.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const where = screen.getByRole("region", { name: "Where this thread runs" });
  expect(where.contains(machine)).toBe(false);
  expect(machine.closest("p")?.textContent).toBe("on This Mac");
});

test("with one device the page doesn't name the machine", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByRole("button", { name: /^Machine:/ })).toBeNull();
  expect(within(screen.getByRole("main")).queryByText(/^on /)).toBeNull();
});
