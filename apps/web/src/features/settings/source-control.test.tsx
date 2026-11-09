import { act, screen, waitFor, within } from "@testing-library/react";
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
  await userEvent.click(screen.getByRole("button", { name: /^Environment: / }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /Build server$/ }));
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

test("adding a host saves it without changing which host's status is shown", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  await screen.findByText("Signed in as ada");
  await userEvent.click(screen.getByRole("button", { name: "Add GitBucket host" }));
  await userEvent.type(screen.getByRole("textbox", { name: "GitBucket host" }), "git.example.com");
  await userEvent.click(screen.getByRole("button", { name: "Add host" }));
  await screen.findByRole("button", { name: "Manage git.example.com" });
  // GitHub's readiness stays on the page; the new host can be shown on request.
  expect(screen.getByText("GitHub CLI")).toBeTruthy();
  expect(screen.getByText("Signed in as ada")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show status for git.example.com" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show status for github.com" })).toBeNull();
  expect(app.daemon.services.settings.get("sourceControl.preferences")).toMatchObject({
    host: "github.com",
    hosts: [{ host: "github.com" }, { host: "git.example.com", forge: "gitbucket" }],
  });
});

test("showing a GitLab host's status reads it through GitLab and keeps GitLab selected on rescan", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  await screen.findByText("Signed in as ada");
  await userEvent.click(screen.getByRole("button", { name: "Add GitLab host" }));
  expect(screen.getByRole("textbox", { name: "GitLab host" })).toHaveProperty(
    "value",
    "gitlab.com",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "a.user_1");
  await userEvent.click(screen.getByRole("button", { name: "Add host" }));
  await userEvent.click(await screen.findByRole("button", { name: "Show status for gitlab.com" }));
  await screen.findByText("Signed in as ada, expected a.user_1");
  expect(screen.getByText("GitLab CLI")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "GitLab host" })).toHaveProperty(
    "value",
    "gitlab.com",
  );
  await userEvent.click(screen.getByRole("button", { name: "Rescan" }));
  await screen.findByText("Signed in as ada, expected a.user_1");
  expect(screen.getByRole("combobox", { name: "Git provider" }).textContent).toContain("GitLab");
});

test("a second GitHub host is managed on its own", async () => {
  const app = harness({ throughWorker: true });
  app.daemon.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "github.com" }, { host: "ghe.example.com", forge: "github" }],
      host: "github.com",
      remote: "origin",
    },
  });
  await app.open("/settings/source-control");
  await screen.findByText("Signed in as ada");
  await userEvent.click(screen.getByRole("button", { name: "Manage ghe.example.com" }));
  expect(screen.getByRole("textbox", { name: "GitHub host" })).toHaveProperty(
    "value",
    "ghe.example.com",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Expected account" }), "octo");
  await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await screen.findByText("ghe.example.com · octo");
  // github.com is untouched and still the host whose status is shown.
  expect(screen.getByText("Signed in as ada")).toBeTruthy();
  expect(app.daemon.services.settings.get("sourceControl.preferences")).toMatchObject({
    host: "github.com",
    hosts: [{ host: "github.com" }, { host: "ghe.example.com", account: "octo" }],
  });
});

test("removing the shown host falls back to another host, and the last host can't be removed", async () => {
  const app = harness({ throughWorker: true });
  app.daemon.services.settings.seed({
    "sourceControl.preferences": {
      hosts: [{ host: "github.com" }, { host: "ghe.example.com", forge: "github" }],
      host: "ghe.example.com",
      remote: "origin",
    },
  });
  await app.open("/settings/source-control");
  await screen.findByText(/· ghe\.example\.com$/);
  await userEvent.click(screen.getByRole("button", { name: "Remove ghe.example.com" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Manage ghe.example.com" })).toBeNull(),
  );
  await screen.findByText(/· github\.com$/);
  expect(screen.getByRole("button", { name: "Manage github.com" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove github.com" })).toBeNull();
});

test("the Git hosts list names every provider, and the provider picker offers each one", async () => {
  const app = harness({ throughWorker: true });
  await app.open("/settings/source-control");
  await screen.findByText("Signed in as ada");
  const hosts = screen.getByRole("region", { name: "Git hosts" });
  expect(within(hosts).getByRole("button", { name: "Manage github.com" })).toBeTruthy();
  for (const name of ["Cursor Origin", "GitLab", "GitBucket", "Bitbucket", "Gitea", "Forgejo"])
    expect(within(hosts).getByRole("button", { name: `Add ${name} host` })).toBeTruthy();
  await userEvent.click(screen.getByRole("combobox", { name: "Git provider" }));
  const offered = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(offered).toEqual([
    "GitHub",
    "Cursor Origin",
    "GitLab",
    "GitBucket",
    "Bitbucket",
    "Gitea",
    "Forgejo",
  ]);
});

test("searching for a Git host provider opens the Git hosts list", async () => {
  await harness().open("/settings/general");
  await userEvent.type(
    await screen.findByRole("searchbox", { name: "Search settings" }),
    "bitbucket",
  );
  await userEvent.click(await screen.findByRole("link", { name: /Git hosts/ }));
  await screen.findByRole("heading", { name: "Source control", level: 2 });
  await waitFor(() =>
    expect(document.getElementById("sourceControl.hosts")?.textContent).toContain("Bitbucket"),
  );
});

test("the host, account and remote rows keep their search anchors", async () => {
  await harness({ throughWorker: true }).open("/settings/source-control#sourceControl.host");
  await screen.findByText("Signed in as ada");
  expect(document.getElementById("sourceControl.host")?.textContent).toContain("GitHub host");
  expect(document.getElementById("sourceControl.provider")?.textContent).toContain("Git provider");
  expect(document.getElementById("sourceControl.account")?.textContent).toContain(
    "Expected account",
  );
  expect(document.getElementById("sourceControl.remote")?.textContent).toContain(
    "Repository remote",
  );
});
