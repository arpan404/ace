import { workbench } from "@ace/fake-daemon";
import { cleanup, configure, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

// jsdom reports a non-Apple platform, so "mod" is Ctrl here.

function app() {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}

const titles = (made: ReturnType<typeof app>) => {
  const view = made.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads" ? Object.values(view.threads).map((row) => row.title) : [];
};

async function write(text: string) {
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), text);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
}

test("Ctrl+Enter starts the thread and stays on New thread, and the toast's Open shows it", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await write("Rotate the relay's signing keys");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  await waitFor(() => expect(titles(made)).toContain("Rotate the relay's signing keys"));
  // Still on New thread, with an empty composer for the next one.
  expect(screen.getByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("");

  await screen.findByText("Thread started");
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByRole("heading", { level: 1, name: "Rotate the relay's signing keys" });
}, 30_000);

test("a start-without-opening key rebound in Settings works on New thread, and Ctrl+Enter then opens", async () => {
  const made = app();
  await made.open("/settings/keyboard");
  const shortcut = await screen.findByRole("button", {
    name: "Start a thread without opening it shortcut",
  });
  expect(shortcut.textContent).toBe("Ctrl+Enter");
  await userEvent.click(shortcut);
  fireEvent.keyDown(shortcut, { key: "Enter", code: "Enter", altKey: true });
  expect(shortcut.textContent).toBe("Alt+Enter");
  await waitFor(() =>
    expect(made.daemon.services.settings.get("clients.keybindings")).toEqual({
      startInBackground: "alt+enter",
    }),
  );
  cleanup();

  await made.open("/new?project=relay");
  await write("Stays in the background");
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  await waitFor(() => expect(titles(made)).toContain("Stays in the background"));
  expect(screen.getByRole("heading", { level: 1, name: "New thread" })).toBeTruthy();

  // Ctrl+Enter is no longer the background key: it sends as Enter does and opens the thread.
  await write("Opens right away");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await screen.findByRole("heading", { level: 1, name: "Opens right away" });
}, 30_000);
