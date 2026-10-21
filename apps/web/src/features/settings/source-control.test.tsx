import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("source control explains a chosen account mismatch and lets the person recover by rescanning", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  expect(await screen.findByText("Signed in as ada")).toBeTruthy();
  // Nothing to save until a preference changes.
  expect(screen.getByRole("button", { name: "Save preferences" })).toHaveProperty("disabled", true);
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "octo");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText(/gh auth switch --hostname github.com --user octo/)).toBeTruthy();
  expect(screen.getByText("Signed in as ada, expected octo")).toBeTruthy();
  await userEvent.clear(screen.getByRole("textbox", { name: "Expected account" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "ada");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText("Signed in as ada")).toBeTruthy();
  expect(screen.queryByText(/gh auth switch/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
  expect(await screen.findByText("Signed in as ada")).toBeTruthy();
  expect(screen.getByText(/API sign-in does not verify Git clone/)).toBeTruthy();
});

test("source control follows the machine picked in Settings, and reconnecting replaces its saved preferences", async () => {
  const app = harness({
    machines: [{ hostId: "build", name: "Build server" }],
    throughWorker: true,
  });
  const remote = app.machines.get("build");
  if (!remote) throw new Error("Missing machine");
  remote.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "git.example.com", account: "octo" }],
      host: "git.example.com",
      remote: "upstream",
    },
  });
  await app.open("/settings/source-control");
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "GitHub host" })).toHaveProperty(
      "value",
      "github.com",
    ),
  );
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(screen.getByRole("combobox", { name: "Machine to edit" }));
  await userEvent.click(await screen.findByRole("option", { name: "Build server" }));
  await screen.findByText(/gh auth switch --hostname git.example.com --user octo/);
  expect(screen.getByRole("textbox", { name: "GitHub host" })).toHaveProperty(
    "value",
    "git.example.com",
  );
  act(() => app.crashMachine("build"));
  await screen.findByText("Build server is offline");
  remote.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "git.example.com", account: "ada" }],
      host: "git.example.com",
      remote: "source",
    },
  });
  await app.pool().reconnect("build");
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Repository remote" })).toHaveProperty(
      "value",
      "source",
    ),
  );
  expect(screen.getByText("Signed in as ada")).toBeTruthy();
});
