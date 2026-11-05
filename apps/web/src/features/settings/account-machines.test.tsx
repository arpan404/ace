import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const origin = "https://backend.example.com";
const build = "B".repeat(52);
const studio = "S".repeat(52);
const session = {
  token: "t".repeat(43),
  expiresAt: 1_900_000_000_000,
  account: { id: "user_ace", email: "ace@example.com", name: "Ace Person" },
};

/** A signed-in window whose ace account backend lists `machines` and records forgets. */
function signedIn(
  machines: { hostId: string; name: string; platform: string; lastSeenAt: number }[],
) {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  const forgotten: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/session") return Response.json(session);
    if (path === "/v1/machines")
      return Response.json({
        machines: machines.filter((machine) => !forgotten.includes(machine.hostId)),
      });
    if (path.startsWith("/v1/machines/") && init?.method === "DELETE") {
      forgotten.push(path.slice("/v1/machines/".length));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return { forgotten };
}

test("machines on the ace account list in Fleet after the paired ones, once each, and can be forgotten", async () => {
  const seen = Date.now() - 2 * 3_600_000;
  const account = signedIn([
    { hostId: build, name: "Build server (account)", platform: "linux", lastSeenAt: seen },
    { hostId: studio, name: "Studio", platform: "darwin", lastSeenAt: seen },
  ]);
  const app = harness({ machines: [{ hostId: build, name: "Build server" }] });
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  expect(await within(machines).findByText("Studio")).toBeDefined();
  expect(within(machines).getByText("On your ace account · macOS · Seen 2h ago")).toBeDefined();
  // Paired and on the account: one row, the paired one, saying it's on the account too.
  expect(within(machines).queryByText("Build server (account)")).toBeNull();
  expect(await within(machines).findByText(/· ace account$/)).toBeDefined();
  expect(within(machines).getAllByRole("link").length + 1).toBe(3);

  await userEvent.click(within(machines).getByRole("button", { name: "Forget Studio" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Forget Studio?" })).getByRole("button", {
      name: "Forget",
    }),
  );
  await waitFor(() => expect(within(machines).queryByText("Studio")).toBeNull());
  expect(account.forgotten).toEqual([studio]);
}, 30_000);

test("a window that isn't signed in to an ace account lists only its paired machines", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    calls.push(String(input));
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  });
  await harness().open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  expect(within(machines).getAllByRole("link")).toHaveLength(1);
  expect(calls.filter((call) => call.includes("/v1/machines"))).toEqual([]);
});

test("the machine code is set, changed and cleared from this machine's page", async () => {
  await harness().open("/settings/remote/primary");
  const code = await screen.findByRole("region", { name: "Security" });
  expect(
    within(code).getByText(/stolen account login; every device enters the code again/),
  ).toBeDefined();
  expect(within(code).getByText("Not set")).toBeDefined();

  await userEvent.click(within(code).getByRole("button", { name: "Set code" }));
  await userEvent.type(within(code).getByLabelText("New machine code"), "12");
  await userEvent.click(within(code).getByRole("button", { name: "Save" }));
  expect(within(code).getByRole("alert").textContent).toBe(
    "A machine code has 4 to 128 characters.",
  );

  await userEvent.type(within(code).getByLabelText("New machine code"), "3456");
  await userEvent.click(within(code).getByRole("button", { name: "Save" }));
  expect(await within(code).findByText("Set")).toBeDefined();
  expect(within(code).queryByLabelText("New machine code")).toBeNull();

  await userEvent.click(within(code).getByRole("button", { name: "Change" }));
  expect(within(code).getByLabelText("New machine code")).toBeDefined();
  await userEvent.click(within(code).getByRole("button", { name: "Cancel" }));

  await userEvent.click(within(code).getByRole("button", { name: "Clear" }));
  expect(await within(code).findByText("Not set")).toBeDefined();
}, 30_000);

test("this machine signs in with the app's ace account and signs out again", async () => {
  signedIn([]);
  await harness().open("/settings/remote/primary");
  const account = await screen.findByRole("region", { name: "Security" });
  expect(
    within(account).getByText("Not signed in. Sign it in to open it from your other devices."),
  ).toBeDefined();
  await userEvent.click(within(account).getByRole("button", { name: "Sign in" }));
  expect(await within(account).findByText(/^Signed in as arpan@example.com/)).toBeDefined();
  await userEvent.click(within(account).getByRole("button", { name: "Sign out" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out" }),
  );
  expect(await within(account).findByText(/^Not signed in/)).toBeDefined();
}, 30_000);

test("signed out everywhere, this machine's page points to Profile instead of signing in", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  await harness().open("/settings/remote/primary");
  const account = await screen.findByRole("region", { name: "Security" });
  expect(
    within(account).getByText("Not signed in. Sign in to your ace account under Profile first."),
  ).toBeDefined();
  expect(within(account).queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(within(account).getByRole("link", { name: "Open Profile" })).toBeDefined();
});

test("signed in, Add machine and Pair a device recommend signing in there with the same account", async () => {
  signedIn([]);
  await harness().open("/settings/remote");
  const next = await screen.findByRole("region", { name: "Next" });
  await userEvent.click(within(next).getByRole("button", { name: "Add machine" }));
  const add = await screen.findByRole("dialog", { name: "Add a machine" });
  const signIn = within(add).getByRole("button", { name: /^Sign in there/ });
  expect(signIn.textContent).toContain("Recommended");
  await userEvent.click(signIn);
  const there = await screen.findByRole("dialog", { name: "Sign in there" });
  expect(within(there).getByText(/sign in with ace@example\.com/)).toBeDefined();
  await userEvent.click(within(there).getByRole("button", { name: "Done" }));

  await userEvent.click(within(next).getByRole("button", { name: "Pair a device" }));
  const pair = await screen.findByRole("dialog", { name: "Add a phone, tablet or browser" });
  await userEvent.click(within(pair).getByRole("button", { name: /^Sign in on the device/ }));
  expect(within(pair).getByRole("link", { name: "app.acehq.dev" })).toBeDefined();
  await userEvent.click(within(pair).getByRole("button", { name: "Back" }));
  await userEvent.click(within(pair).getByRole("button", { name: /^Show a pairing code/ }));
  expect(
    await within(await screen.findByRole("dialog", { name: "Pair a device" })).findByRole(
      "button",
      { name: "Create link" },
    ),
  ).toBeDefined();
}, 30_000);

test("this computer signs in to the account from How this computer is reached, and out again", async () => {
  signedIn([]);
  await harness().open("/settings/remote");
  const reached = await screen.findByRole("region", { name: "How this computer is reached" });
  await userEvent.click(await within(reached).findByRole("button", { name: "Sign in" }));
  // The fake daemon signs in as its own person, so the row also says it isn't this app's.
  expect(await within(reached).findByText(/^Signed in as arpan@example\.com/)).toBeDefined();
  await userEvent.click(within(reached).getByRole("button", { name: "Sign out" }));
  const ask = await screen.findByRole("dialog", { name: "Sign this computer out?" });
  expect(within(ask).getByText(/until it signs back in\./)).toBeDefined();
  await userEvent.click(within(ask).getByRole("button", { name: "Sign out" }));
  expect(await within(reached).findByText(/^Not signed in/)).toBeDefined();
}, 30_000);
