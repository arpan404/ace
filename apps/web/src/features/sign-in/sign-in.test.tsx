import type { ProviderKind, ProviderStatus } from "@ace/protocol";
import { replayCursor, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";
import { openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

type Harness = ReturnType<typeof harness>;

/** Stage what discovery reports for a provider's own CLI login. */
function stage(app: Harness, provider: ProviderKind, row: Partial<ProviderStatus>) {
  const found = app.daemon.services.providerStatuses.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`No ${provider} discovery`);
  Object.assign(found, row);
}

/** The fake numbers sessions as they start: the first sign-in on a daemon is fake-login-1. */
const session = (n: number) => `fake-login-${n}`;

async function providersPage(app: Harness) {
  await app.open("/settings/providers");
  return screen.findByRole("region", { name: "Providers" }, { timeout: 10_000 });
}

test("a device sign-in shows its code and link, and finishing in the browser signs in everywhere", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_out", accountLabel: "grace@example.com" });
  const providers = await providersPage(app);
  await userEvent.click(await within(providers).findByRole("button", { name: "Sign in to Codex" }));

  const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" });
  expect((await within(dialog).findByLabelText("Sign-in code")).textContent).toBe("ACEF-2048");
  const link = within(dialog).getByRole("link", { name: "Open sign-in page" });
  expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
  expect(within(dialog).getByText("Waiting for you to finish in the browser…")).toBeTruthy();

  app.daemon.services.providerLogin.complete(session(1));
  expect(await within(dialog).findByText("Signed in as grace@example.com")).toBeTruthy();
  // The dialog closes by itself, and Settings caught up without a reload.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4_000 });
  expect(within(providers).getByText("Signed in as grace@example.com")).toBeTruthy();
  // Signed in, it asks for nothing: no loud button, its actions in a quiet menu.
  expect(within(providers).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
  expect(within(providers).getByRole("button", { name: "More for Codex" })).toBeTruthy();
}, 30_000);

test("the CLI's own choices are buttons; a choice then Enter leads to its device code", async () => {
  const app = harness();
  stage(app, "opencode", { auth: "logged_out" });
  const providers = await providersPage(app);
  await userEvent.click(
    await within(providers).findByRole("button", { name: "Sign in to OpenCode" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to OpenCode" });
  const choices = await within(dialog).findByRole("group", {
    name: "Choose the account provider.",
  });
  expect(
    within(choices)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["GitHub Copilot", "OpenAI / ChatGPT", "Claude", "OpenCode Go", "OpenCode Zen"]);
  await userEvent.click(within(choices).getByRole("button", { name: "GitHub Copilot" }));
  await within(dialog).findByText("Press Enter to continue.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await within(dialog).findByLabelText("Sign-in code")).textContent).toBe("ACEF-2048");
  expect(within(dialog).getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(
    "https://github.com/login/device",
  );
}, 30_000);

test("Cancel ends the login on the daemon, so trying again starts a fresh one", async () => {
  const app = harness();
  stage(app, "claude", { auth: "logged_out" });
  const providers = await providersPage(app);
  await userEvent.click(
    await within(providers).findByRole("button", { name: "Sign in to Claude Code" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  expect(
    (await within(dialog).findByRole("link", { name: "Open sign-in page" })).getAttribute("href"),
  ).toMatch(/^https:\/\/claude\.ai\//);

  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(await within(dialog).findByText("Sign-in cancelled")).toBeTruthy();
  // The daemon let the first login go: a second one isn't refused as busy.
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeTruthy();
  expect(within(dialog).queryByText(/already running/)).toBeNull();
}, 30_000);

test("a failed sign-in says why, and Try again starts over", async () => {
  const app = harness();
  stage(app, "claude", { auth: "logged_out" });
  app.daemon.services.providerLogin.scenarios.claude = "failure";
  const providers = await providersPage(app);
  await userEvent.click(
    await within(providers).findByRole("button", { name: "Sign in to Claude Code" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  expect(await within(dialog).findByText("The provider declined sign-in. Try again.")).toBeTruthy();

  app.daemon.services.providerLogin.scenarios.claude = "browser";
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeTruthy();
  app.daemon.services.providerLogin.complete(session(2));
  expect(await within(dialog).findByText("Signed in as ada@example.com")).toBeTruthy();
}, 30_000);

test("a sign-in that needs a key typed runs the CLI in an ace terminal, then reads signed in", async () => {
  const app = harness();
  stage(app, "opencode", { auth: "logged_out" });
  const providers = await providersPage(app);
  await userEvent.click(
    await within(providers).findByRole("button", { name: "Sign in to OpenCode" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to OpenCode" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "OpenCode Go" }));

  // The exact steps, with the command the terminal runs.
  const steps = await within(dialog).findByRole("list");
  expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
  expect(within(steps).getByText("opencode auth login")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Open terminal here" }));

  // The CLI's own prompt, in a terminal in the dialog; ace never reads what is typed there.
  expect(
    await within(dialog).findByText(
      "Complete the provider's own sign-in flow.",
      {},
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(await within(dialog).findByText("Signed in to OpenCode")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(within(providers).queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull(),
  );
}, 30_000);

test("Sign out runs the CLI's logout and the provider reads signed out", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_in", accountLabel: "grace@example.com" });
  const providers = await providersPage(app);
  await userEvent.click(await within(providers).findByRole("button", { name: "More for Codex" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign out of Codex" });
  expect(await within(dialog).findByText("Signed out of Codex")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4_000 });
  expect(await within(providers).findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
  expect(within(providers).queryByText("Signed in as grace@example.com")).toBeNull();
}, 30_000);

test("each of OpenCode's upstreams signs in on its own: its choice is made for the person", async () => {
  const app = harness();
  stage(app, "opencode", { auth: "logged_in" });
  const providers = await providersPage(app);
  const upstreams = await within(providers).findByRole(
    "list",
    { name: "OpenCode providers" },
    { timeout: 10_000 },
  );
  expect(
    within(upstreams).getByText("OpenRouter could not be reached.", { exact: false }),
  ).toBeTruthy();
  // A failing upstream says Reconnect; one that works keeps Sign in again in a quiet menu.
  expect(within(upstreams).getByRole("button", { name: "Reconnect OpenRouter" })).toBeTruthy();
  expect(within(upstreams).queryByRole("button", { name: "Reconnect OpenAI" })).toBeNull();
  await userEvent.click(within(upstreams).getByRole("button", { name: "More for OpenAI" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Sign in again" }));

  const dialog = await screen.findByRole("dialog", { name: "Sign in to OpenCode" });
  // OpenAI was chosen from the CLI's list without asking again.
  expect(await within(dialog).findByText("Press Enter to continue.")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "GitHub Copilot" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect(await within(dialog).findByLabelText("Sign-in code")).toBeTruthy();
}, 30_000);

test("Settings asks only where something's wrong: Sign in when signed out, Reconnect when it needs attention", async () => {
  // The fake's machine: Claude Code and Codex signed in, OpenCode signed out, Pi not reporting
  // its sign-in but listing models, Cursor's sign-in expired.
  const providers = await providersPage(harness());
  await within(providers).findByRole("button", { name: "Sign in to OpenCode" });
  expect(await within(providers).findByRole("button", { name: "Reconnect Cursor" })).toBeTruthy();
  expect(within(providers).getByText("Needs attention · Cursor sign-in has expired.")).toBeTruthy();
  for (const name of ["Claude Code", "Codex", "Pi"]) {
    expect(within(providers).queryByRole("button", { name: `Sign in to ${name}` })).toBeNull();
    expect(within(providers).queryByRole("button", { name: `Reconnect ${name}` })).toBeNull();
    expect(within(providers).getByRole("button", { name: `More for ${name}` })).toBeTruthy();
  }
  // Not reporting a sign-in isn't a problem.
  expect(within(providers).getAllByText(/Needs attention/)).toHaveLength(1);
}, 30_000);

test("a sign-in finished on another connection updates Settings live", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_out", accountLabel: "grace@example.com" });
  const providers = await providersPage(app);
  await within(providers).findByRole("button", { name: "Sign in to Codex" });

  const other = fakeClient(app.daemon);
  await other.start();
  await waitFor(() => expect(other.state).toBe("ready"));
  const started = await other.request({ type: "provider.login.start", provider: "codex" });
  if (!started.result.ok) throw new Error("The fake refused to start");
  app.daemon.services.providerLogin.complete(started.result.progress.session);

  expect(await within(providers).findByText("Signed in as grace@example.com")).toBeTruthy();
  expect(within(providers).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
}, 30_000);

test("the model picker's expired-sign-in row signs in to Cursor, and its models come back", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const popover = await openModelControl(/^Model: /);
  const list = await openModelPicker(popover);
  await userEvent.click(within(popover).getByRole("tab", { name: "Cursor" }));
  expect(within(list).getByText("Cursor sign-in has expired.")).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Sign in" }));

  const dialog = await screen.findByRole("dialog", { name: "Sign in to Cursor" });
  expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeTruthy();
  app.daemon.services.providerLogin.complete(session(1));
  expect(await within(dialog).findByText("Signed in to Cursor")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));

  // The catalog was read again: the picker no longer says the sign-in expired.
  const again = await openModelPicker(await openModelControl(/^Model: /));
  await userEvent.click(
    within(screen.getByRole("dialog", { name: "Model and effort" })).getByRole("tab", {
      name: "Cursor",
    }),
  );
  await waitFor(() => expect(within(again).queryByText("Cursor sign-in has expired.")).toBeNull());
}, 30_000);

test("New thread on a signed-out provider says so, with Sign in right there", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  stage(app, "codex", { auth: "logged_out" });
  app.daemon.services.settings.seed({ "providers.default": "codex" });
  await app.open("/new?project=relay");
  const notice = await screen.findByText(
    "Codex isn't signed in. Sign in to start this thread.",
    {},
    { timeout: 10_000 },
  );
  await userEvent.click(
    within(notice.parentElement ?? notice).getByRole("button", { name: "Sign in" }),
  );
  expect(await screen.findByRole("dialog", { name: "Sign in to Codex" })).toBeTruthy();
}, 30_000);
