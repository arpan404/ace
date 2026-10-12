import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("source control explains a chosen account mismatch and lets the person recover by rescanning", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "octo");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText(/gh auth switch --hostname github.com --user octo/)).toBeTruthy();
  await userEvent.clear(screen.getByRole("textbox", { name: "Expected account" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "ada");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
  expect(await screen.findByText(/GitHub API access verified as ada/)).toBeTruthy();
  expect(screen.getByText(/API sign-in does not verify Git clone/)).toBeTruthy();
});

test("switching source control machines and reconnecting replaces their saved preferences", async () => {
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
  await screen.findByText(/GitHub API access verified as ada on github.com/);
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(screen.getByRole("combobox", { name: "Source control machine" }));
  await userEvent.click(await screen.findByRole("option", { name: "Build server" }));
  await screen.findByText(/gh auth switch --hostname git.example.com --user octo/);
  expect(screen.queryByText(/verified as ada on github.com/)).toBeNull();
  act(() => app.crashMachine("build"));
  await screen.findByText(/Connect to this machine to inspect/);
  remote.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "git.example.com", account: "ada" }],
      host: "git.example.com",
      remote: "source",
    },
  });
  await app.pool().reconnect("build");
  await screen.findByText(/GitHub API access verified as ada on git.example.com/);
  expect(screen.getByRole("textbox", { name: "Repository remote" })).toHaveProperty(
    "value",
    "source",
  );
});
