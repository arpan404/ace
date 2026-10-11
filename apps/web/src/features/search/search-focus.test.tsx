import { workbench } from "@ace/fake-daemon";
import { ServerMessage } from "@ace/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Search keeps keyboard control when the new-thread composer finishes loading behind it", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const connect = app.daemon.connect.bind(app.daemon);
  const pending: (() => void)[] = [];
  let held = true;
  const transport = vi.spyOn(app.daemon, "connect").mockImplementation((wire) =>
    connect({
      ...wire,
      send(text) {
        const message = ServerMessage.parse(JSON.parse(text));
        if (held && message.type === "workspace.result" && message.result.kind === "workspaces")
          pending.push(() => wire.send(text));
        else wire.send(text);
      },
    }),
  );
  onTestFinished(() => {
    pending.length = 0;
    transport.mockRestore();
  });
  await app.open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("button", { name: "Search" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  const field = within(dialog).getByRole("combobox", { name: "Search every thread" });
  await userEvent.type(field, "retry budget");
  await within(await screen.findByRole("listbox", { name: "Results" })).findAllByRole("option");
  expect(screen.queryByRole("combobox", { name: "Message", hidden: true })).toBeNull();

  act(() => {
    held = false;
    for (const deliver of pending.splice(0)) deliver();
  });
  expect(await screen.findByRole("combobox", { name: "Message", hidden: true })).toBeTruthy();
  expect(document.activeElement).toBe(field);
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByRole("heading", { level: 1, name: "Retry budget for app-server restarts" }),
  ).toBeTruthy();
});
