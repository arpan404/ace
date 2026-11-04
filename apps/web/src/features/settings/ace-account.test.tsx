import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

/** Sign out asks first; this answers it. */
async function confirmSignOut() {
  const ask = await screen.findByRole("dialog", { name: "Sign out?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Sign out" }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

test("local settings remain usable without an ace account deployment", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", "");
  await harness().open("/settings/profile");
  expect((await screen.findByRole("button", { name: "Sign in" })).hasAttribute("disabled")).toBe(
    true,
  );
  await userEvent.clear(screen.getByRole("textbox", { name: "Your name" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Your name" }), "Local Person");
  expect(screen.getByRole("textbox", { name: "Your name" })).toHaveProperty(
    "value",
    "Local Person",
  );
});

test("a saved account finishes restoring before sign-out becomes available", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_saved", email: "saved@example.com", name: "Saved Person" },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  let finish: ((value: Response) => void) | undefined;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal("fetch", async () => response);
  await harness().open("/settings/profile");
  const signOut = await screen.findByRole("button", { name: "Sign out" });
  expect(signOut.hasAttribute("disabled")).toBe(true);
  finish?.(Response.json(session));
  await waitFor(() => expect(signOut.hasAttribute("disabled")).toBe(false));
  expect(screen.getByText("Saved Person")).toBeDefined();
});

test("browser sign-in survives a transient backend failure and sign-out removes its session", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  let verified = false,
    revoked = false,
    retry = false,
    started: unknown;
  const grant = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_ace", email: "ace@example.com", name: "Ace Person" },
  };
  vi.stubGlobal("ace", {
    shell: {
      openExternal: async () => {
        verified = true;
      },
    },
  });
  const network: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account/login" && init?.method === "POST") {
      started = JSON.parse(String(init.body));
      return Response.json({
        id: "i".repeat(43),
        secret: "s".repeat(43),
        expiresAt: 1_900_000_000_000,
        loginUrl: `${origin}/v1/account/login?id=${"i".repeat(43)}`,
      });
    }
    if (path.startsWith("/v1/account/login/") && init?.method === "GET") {
      if (!retry) {
        retry = true;
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      return Response.json(
        verified ? { status: "complete", session: grant } : { status: "pending" },
      );
    }
    if (path === "/v1/account/session" && init?.method === "DELETE") {
      revoked = true;
      return Response.json({ ok: true });
    }
    if (path === "/v1/account/session")
      return Response.json(grant, { status: revoked ? 401 : 200 });
    return Response.json({ ok: true });
  };
  vi.stubGlobal("fetch", network);
  await harness().open("/settings/profile");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  const signOut = await screen.findByRole("button", { name: "Sign out" }, { timeout: 8000 });
  expect(screen.getByText("Ace Person")).toBeDefined();
  // The browser comes back to this web app's landing page, not the backend's dead end.
  expect(started).toEqual({ returnTo: `${location.origin}/account/signed-in` });
  await userEvent.click(signOut);
  await confirmSignOut();
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined());
  expect((await network(`${origin}/v1/account/session`, { method: "GET" })).status).toBe(401);
  expect(sessionStorage.getItem(`ace.account.session:${origin}`)).toBeNull();
  expect(screen.getByRole("textbox", { name: "Your name" })).toBeDefined();
});

test("signing out a session the backend already ended still signs this window out", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_gone", email: "gone@example.com", name: "Gone Person" },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) =>
    init?.method === "DELETE"
      ? Response.json({ error: "unauthenticated" }, { status: 401 })
      : Response.json(session),
  );
  await harness().open("/settings/profile");
  const signOut = await screen.findByRole("button", { name: "Sign out" });
  await waitFor(() => expect(signOut.hasAttribute("disabled")).toBe(false));
  await userEvent.click(signOut);
  await confirmSignOut();
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sessionStorage.getItem(`ace.account.session:${origin}`)).toBeNull();
});

test("Sign out asks first, says the person's work stays, and Cancel keeps them signed in", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_kept", email: "kept@example.com", name: "Kept Person" },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  const deletes: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "DELETE") deletes.push(input);
    return Response.json(session);
  });
  await harness().open("/settings/profile");
  const signOut = await screen.findByRole("button", { name: "Sign out" });
  await waitFor(() => expect(signOut.hasAttribute("disabled")).toBe(false));
  await userEvent.click(signOut);
  const ask = await screen.findByRole("dialog", { name: "Sign out?" });
  expect(within(ask).getByText(/Your threads and drafts stay on this device\./)).toBeDefined();
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(deletes).toEqual([]);
  expect(screen.getByText("Kept Person")).toBeDefined();
  expect(sessionStorage.getItem(`ace.account.session:${origin}`)).not.toBeNull();
});

test("returning from a cancelled desktop sign-in says so on Profile until the next attempt", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", "https://backend.example.com");
  vi.stubGlobal("fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await harness().open("/settings/profile?signin=cancelled");
  expect((await screen.findByRole("alert")).textContent).toBe("Sign-in was cancelled.");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.queryByText("Sign-in was cancelled.")).toBeNull());
});

test("a sign-in keeps going while the person leaves Settings and finishes in the browser", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  let finished = false,
    cancelled = false;
  const grant = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_away", email: "away@example.com", name: "Away Person" },
  };
  vi.stubGlobal("ace", { shell: { openExternal: async () => {} } });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/v1/account/login" && init?.method === "POST")
      return Response.json({
        id: "i".repeat(43),
        secret: "s".repeat(43),
        expiresAt: 1_900_000_000_000,
        loginUrl: `${origin}/v1/account/login?id=${"i".repeat(43)}`,
      });
    if (path.startsWith("/v1/account/login/") && init?.method === "DELETE") {
      cancelled = true;
      return Response.json({ ok: true });
    }
    if (path.startsWith("/v1/account/login/"))
      return Response.json(
        finished && !cancelled ? { status: "complete", session: grant } : { status: "pending" },
      );
    return Response.json({ error: "unavailable" }, { status: 503 });
  });
  const history = createMemoryHistory({ initialEntries: ["/settings/profile"] });
  await harness({ history }).open("/settings/profile");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Finishing sign-in in your browser")).toBeDefined();
  await act(() => history.push("/settings/appearance"));
  await waitFor(() => expect(screen.queryByRole("region", { name: "ace account" })).toBeNull());
  finished = true;
  await act(() => history.push("/settings/profile"));
  expect(await screen.findByText("Away Person", {}, { timeout: 8000 })).toBeDefined();
  expect(cancelled).toBe(false);
});

test("the account menu shows who is signed in and opens their Profile", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_menu", email: "menu@example.com", name: "Menu Person" },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  vi.stubGlobal("fetch", async (input: string) =>
    new URL(input).pathname === "/v1/machines"
      ? Response.json({ machines: [] })
      : Response.json(session),
  );
  await harness().open("/new");
  const rail = await screen.findByRole("button", { name: "Menu Person, account" });
  expect(within(rail).getByText("MP")).toBeDefined();
  await userEvent.click(rail);
  const header = await screen.findByRole("menuitem", { name: /Menu Person/ });
  expect(within(header).getByText("menu@example.com")).toBeDefined();
  await userEvent.click(header);
  const profile = await screen.findByRole("region", { name: "ace account" });
  expect(within(profile).getByRole("heading", { name: "Menu Person" })).toBeDefined();
  expect(within(profile).getByText("menu@example.com")).toBeDefined();
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Your name" })).toBeDefined();
});

test("a sign-in that fails in the browser says it didn't finish, not that it expired", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  vi.stubGlobal("ace", { shell: { openExternal: async () => {} } });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/v1/account/login" && init?.method === "POST")
      return Response.json({
        id: "i".repeat(43),
        secret: "s".repeat(43),
        expiresAt: 1_900_000_000_000,
        loginUrl: `${origin}/v1/account/login?id=${"i".repeat(43)}`,
      });
    if (path.startsWith("/v1/account/login/"))
      return Response.json({ error: "login_failed" }, { status: 410 });
    return Response.json({ error: "unavailable" }, { status: 503 });
  });
  await harness().open("/settings/profile");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert", {}, { timeout: 8000 })).textContent).toBe(
    "Sign-in didn't finish. Try again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
});

test("an account's picture shows on the rail, in the account menu and on Profile", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_pic", email: "pic@example.com", name: "Pic Person", picture: true },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
    ),
    (char) => char.charCodeAt(0),
  );
  let pictureReads = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/v1/account/picture") {
      pictureReads += 1;
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    if (path === "/v1/machines") return Response.json({ machines: [] });
    return Response.json(session);
  });
  await harness().open("/settings/profile");
  const rail = await screen.findByRole("button", { name: "Pic Person, account" });
  await waitFor(() =>
    expect(rail.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/),
  );
  const profile = screen.getByRole("region", { name: "ace account" });
  expect(profile.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
  await userEvent.click(rail);
  const header = await screen.findByRole("menuitem", { name: /Pic Person/ });
  expect(header.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
  // One read serves every place it shows.
  expect(pictureReads).toBe(1);
});

test("an account without a picture keeps its initials and never asks for one", async () => {
  const origin = "https://backend.example.com";
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  const session = {
    token: "t".repeat(43),
    expiresAt: 1_900_000_000_000,
    account: { id: "user_plain", email: "plain@example.com", name: "Plain Person" },
  };
  sessionStorage.setItem(`ace.account.session:${origin}`, JSON.stringify(session));
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    asked.push(new URL(input).pathname);
    if (new URL(input).pathname === "/v1/machines") return Response.json({ machines: [] });
    return Response.json(session);
  });
  await harness().open("/settings/profile");
  const rail = await screen.findByRole("button", { name: "Plain Person, account" });
  expect(within(rail).getByText("PP")).toBeDefined();
  expect(rail.querySelector("img")).toBeNull();
  expect(asked).not.toContain("/v1/account/picture");
});
