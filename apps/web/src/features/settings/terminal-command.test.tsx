import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const command = "/Users/ada/.ace/bin/ace";

/** The desktop's preload bridge with the `ace` command off, as the main process keeps it. */
function desktop() {
  const stored = {
    background: true,
    openAtLogin: false,
    preventSleep: false,
    attention: true,
    globalShortcut: null,
    notifications: { enabled: true, categories: {}, quietHours: null },
  };
  let current: unknown = { state: "off", command };
  const changes: boolean[] = [];
  vi.stubGlobal("ace", {
    settings: { get: async () => stored, update: async () => stored, onChange: () => () => {} },
    cli: {
      status: async () => current,
      setOnPath: async (on: boolean) => {
        changes.push(on);
        current = on ? { state: "added", files: ["/Users/ada/.zshrc"] } : { state: "off", command };
        return current;
      },
    },
  });
  return { changes };
}

afterEach(() => vi.unstubAllGlobals());

test("turning on the ace command in Settings says where it went and to open a new terminal", async () => {
  const machine = desktop();
  await harness().open("/settings/general");
  const toggle = await screen.findByRole("switch", { name: "ace command in terminals" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);

  expect(machine.changes).toEqual([true]);
  expect(
    await screen.findByText(
      "Added to PATH in /Users/ada/.zshrc. Open a new terminal window to use it.",
    ),
  ).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("a browser shows no ace command row", async () => {
  await harness().open("/settings/general");
  await screen.findByText("Your name");
  expect(screen.queryByRole("switch", { name: "ace command in terminals" })).toBeNull();
});
