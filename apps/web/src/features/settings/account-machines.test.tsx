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
  const machines = await screen.findByRole("region", { name: "Computers" });
  expect(await within(machines).findByText("Studio")).toBeDefined();
  expect(within(machines).getByText("macOS · Seen 2h ago")).toBeDefined();
  // Paired and on the account: one row, the paired one, saying it's on the account too.
  expect(within(machines).queryByText("Build server (account)")).toBeNull();
  expect(await within(machines).findByText(/On your ace account/)).toBeDefined();
  expect(within(machines).getByRole("status").textContent).toBe("3 computers");

  await userEvent.click(within(machines).getByRole("button", { name: "Actions for Studio" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Forget" }));
  await userEvent.click(await screen.findByRole("button", { name: "Forget" }));
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
  const machines = await screen.findByRole("region", { name: "Computers" });
  expect(within(machines).getByRole("status").textContent).toBe("1 computer");
  expect(calls.filter((call) => call.includes("/v1/machines"))).toEqual([]);
});

test("the machine code is set, changed and cleared from this machine's page", async () => {
  await harness().open("/settings/remote/primary");
  const code = await screen.findByRole("region", { name: "ace account" });
  expect(
    within(code).getByText(/stolen account login; every device enters the code again/),
  ).toBeDefined();
  expect(within(code).getByText("Not set")).toBeDefined();

  await userEvent.click(within(code).getByRole("button", { name: "Set code" }));
  await userEvent.type(within(code).getByLabelText("New computer code"), "12");
  await userEvent.click(within(code).getByRole("button", { name: "Save" }));
  expect(within(code).getByRole("alert").textContent).toBe(
    "A computer code has 4 to 128 characters.",
  );

  await userEvent.type(within(code).getByLabelText("New computer code"), "3456");
  await userEvent.click(within(code).getByRole("button", { name: "Save" }));
  expect(await within(code).findByText("Set")).toBeDefined();
  expect(within(code).queryByLabelText("New computer code")).toBeNull();

  await userEvent.click(within(code).getByRole("button", { name: "Change" }));
  expect(within(code).getByLabelText("New computer code")).toBeDefined();
  await userEvent.click(within(code).getByRole("button", { name: "Cancel" }));

  await userEvent.click(within(code).getByRole("button", { name: "Clear" }));
  expect(await within(code).findByText("Not set")).toBeDefined();
}, 30_000);

test("this machine signs in with the app's ace account and signs out again", async () => {
  signedIn([]);
  await harness().open("/settings/remote/primary");
  const account = await screen.findByRole("region", { name: "ace account" });
  expect(
    within(account).getByText("Not signed in. Sign it in to open it from your other devices."),
  ).toBeDefined();
  await userEvent.click(within(account).getByRole("button", { name: "Sign in" }));
  expect(await within(account).findByText(/^Signed in as arpan@example.com/)).toBeDefined();
  await userEvent.click(within(account).getByRole("button", { name: "Sign out" }));
  expect(await within(account).findByText(/^Not signed in/)).toBeDefined();
}, 30_000);

test("signed out everywhere, this machine's page points to Profile instead of signing in", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  await harness().open("/settings/remote/primary");
  const account = await screen.findByRole("region", { name: "ace account" });
  expect(
    within(account).getByText("Not signed in. Sign in to your ace account under Profile first."),
  ).toBeDefined();
  expect(within(account).queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(within(account).getByRole("link", { name: "Open Profile" })).toBeDefined();
});
