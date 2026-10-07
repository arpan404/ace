import type { ProviderKind, ProviderStatus } from "@ace/protocol";
import { replayCursor, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";
import { openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());
afterEach(() => Reflect.deleteProperty(globalThis, "ace"));

type Harness = ReturnType<typeof harness>;

/** Stage what discovery reports for a provider's own CLI login. */
function stage(app: Harness, provider: ProviderKind, row: Partial<ProviderStatus>) {
  const found = app.daemon.services.providerStatuses.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`No ${provider} discovery`);
  Object.assign(found, row);
}

/** No upstream of OpenCode or Pi lists models: nothing is connected through it. */
function disconnect(app: Harness, provider: ProviderKind) {
  app.daemon.services.models = app.daemon.services.models.filter(
    (model) => model.provider !== provider,
  );
}

/** The fake numbers sessions as they start: the first sign-in on a daemon is fake-login-1. */
const session = (n: number) => `fake-login-${n}`;

async function providersList(app: Harness) {
  await app.open("/settings/providers");
  return screen.findByRole("region", { name: "On this computer" }, { timeout: 10_000 });
}

test("a device sign-in shows its code to copy and its page, and finishing in the browser signs in everywhere", async () => {
  const user = userEvent.setup();
  const app = harness();
  stage(app, "codex", { auth: "logged_out", accountLabel: "grace@example.com" });
  const list = await providersList(app);
  await user.click(await within(list).findByRole("button", { name: "Sign in to Codex" }));

  const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" });
  expect((await within(dialog).findByLabelText("Sign-in code")).textContent).toBe("ACEF-2048");
  const link = within(dialog).getByRole("link", { name: /open sign-in page/i });
  expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
  expect(within(dialog).getByText("Waiting for you to finish in your browser")).toBeTruthy();
  // The code itself copies it, and says so.
  await user.click(within(dialog).getByRole("button", { name: /copy code/i }));
  expect(await within(dialog).findByText("Copied")).toBeTruthy();
  expect(await navigator.clipboard.readText()).toBe("ACEF-2048");

  app.daemon.services.providerLogin.complete(session(1));
  expect(await within(dialog).findByText("Signed in as grace@example.com")).toBeTruthy();
  // The dialog closes by itself, and Settings caught up without a reload.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4_000 });
  expect(within(list).getByText("Signed in as grace@example.com")).toBeTruthy();
  // Signed in, the list asks for nothing.
  expect(within(list).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
}, 30_000);

test("in the desktop app a browser sign-in opens its page by itself, once", async () => {
  const opened: string[] = [];
  Reflect.set(globalThis, "ace", {
    shell: { openExternal: async (url: string) => void opened.push(url) },
  });
  const app = harness();
  stage(app, "claude", { auth: "logged_out" });
  const list = await providersList(app);
  await userEvent.click(within(list).getByRole("button", { name: "Sign in to Claude Code" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  const again = await within(dialog).findByRole("link", { name: /open sign-in page again/i });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^https:\/\/claude\.ai\//);
  await userEvent.click(again);
  await waitFor(() => expect(opened).toHaveLength(2));
}, 30_000);

test("connecting OpenCode lists its services with what each means; a choice then Continue leads to its code", async () => {
  const app = harness();
  stage(app, "opencode", { auth: "logged_out" });
  disconnect(app, "opencode");
  const list = await providersList(app);
  await userEvent.click(await within(list).findByRole("button", { name: "Sign in to OpenCode" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to OpenCode" });
  const choices = await within(dialog).findByRole("group", {
    name: "Which service do you want to connect?",
  });
  expect(
    within(choices)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["GitHub Copilot", "OpenAI / ChatGPT", "Claude", "OpenCode Go", "OpenCode Zen"]);
  expect(within(choices).getByText("Use your GitHub Copilot plan")).toBeTruthy();
  await userEvent.click(within(choices).getByRole("button", { name: "GitHub Copilot" }));
  expect(await within(dialog).findByText("Press Enter to continue.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  expect((await within(dialog).findByLabelText("Sign-in code")).textContent).toBe("ACEF-2048");
  expect(
    within(dialog)
      .getByRole("link", { name: /open sign-in page/i })
      .getAttribute("href"),
  ).toBe("https://github.com/login/device");
}, 30_000);

test("Cancel ends the login on the daemon, so trying again starts a fresh one", async () => {
  const app = harness();
  stage(app, "claude", { auth: "logged_out" });
  const list = await providersList(app);
  await userEvent.click(
    await within(list).findByRole("button", { name: "Sign in to Claude Code" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  expect(
    (await within(dialog).findByRole("link", { name: /open sign-in page/i })).getAttribute("href"),
  ).toMatch(/^https:\/\/claude\.ai\//);

  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(await within(dialog).findByText("Sign-in cancelled")).toBeTruthy();
  // The daemon let the first login go: a second one isn't refused as busy.
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(await within(dialog).findByRole("link", { name: /open sign-in page/i })).toBeTruthy();
  expect(within(dialog).queryByText(/already signing in/)).toBeNull();
}, 30_000);

test("a failed sign-in says why, and Try again starts over", async () => {
  const app = harness();
  stage(app, "claude", { auth: "logged_out" });
  app.daemon.services.providerLogin.scenarios.claude = "failure";
  const list = await providersList(app);
  await userEvent.click(
    await within(list).findByRole("button", { name: "Sign in to Claude Code" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
  expect(await within(dialog).findByText("The provider declined sign-in. Try again.")).toBeTruthy();

  app.daemon.services.providerLogin.scenarios.claude = "browser";
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(await within(dialog).findByRole("link", { name: /open sign-in page/i })).toBeTruthy();
  app.daemon.services.providerLogin.complete(session(2));
  expect(await within(dialog).findByText("You're signed in")).toBeTruthy();
  expect(within(dialog).getByText("Signed in as ada@example.com")).toBeTruthy();
}, 30_000);

test("a sign-in that needs a key typed runs the CLI in an ace terminal, in three plain steps", async () => {
  const app = harness();
  stage(app, "opencode", { auth: "logged_out" });
  disconnect(app, "opencode");
  const list = await providersList(app);
  await userEvent.click(await within(list).findByRole("button", { name: "Sign in to OpenCode" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to OpenCode" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "OpenCode Go" }));

  expect(await within(dialog).findByText("Finish in a terminal")).toBeTruthy();
  const steps = within(dialog).getAllByRole("list")[0];
  if (!steps) throw new Error("No steps");
  expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
  expect(within(steps).getByText("opencode auth login")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Open terminal" }));

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
    expect(within(list).queryByRole("button", { name: "Sign in to OpenCode" })).toBeNull(),
  );
}, 30_000);

test("Sign out on a provider's page runs the CLI's logout, and the provider reads signed out", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_in", accountLabel: "grace@example.com" });
  await app.open("/settings/providers/codex");
  const signOut = await screen.findByRole(
    "region",
    { name: "Sign out of Codex" },
    { timeout: 10_000 },
  );
  await userEvent.click(within(signOut).getByRole("button", { name: "Sign out" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign out of Codex" });
  expect(await within(dialog).findByText("Signed out of Codex")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4_000 });
  // The page now leads with what to do about it.
  expect(await screen.findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
  expect(screen.queryByText("Signed in as grace@example.com")).toBeNull();
}, 30_000);

test("a sign-in finished on another connection updates Settings live", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_out", accountLabel: "grace@example.com" });
  const list = await providersList(app);
  await within(list).findByRole("button", { name: "Sign in to Codex" });

  const other = fakeClient(app.daemon);
  await other.start();
  await waitFor(() => expect(other.state).toBe("ready"));
  const started = await other.request({ type: "provider.login.start", provider: "codex" });
  if (!started.result.ok) throw new Error("The fake refused to start");
  app.daemon.services.providerLogin.complete(started.result.progress.session);

  expect(await within(list).findByText("Signed in as grace@example.com")).toBeTruthy();
  expect(within(list).queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
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
  expect(await within(dialog).findByRole("link", { name: /open sign-in page/i })).toBeTruthy();
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

test("a sign-in the daemon refuses as busy says so and offers to try again", async () => {
  const app = harness();
  stage(app, "codex", { auth: "logged_out" });
  // Another connection holds Codex's sign-in.
  const other = fakeClient(app.daemon);
  await other.start();
  await waitFor(() => expect(other.state).toBe("ready"));
  await other.request({ type: "provider.login.start", provider: "codex" });
  const list = await providersList(app);
  await userEvent.click(within(list).getByRole("button", { name: "Sign in to Codex" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" });
  expect(await within(dialog).findByText("Codex is already signing in")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
}, 30_000);
