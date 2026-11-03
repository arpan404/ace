import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

test("local settings remain usable without an ace account deployment", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", "");
  await harness().open("/settings/general");
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
  await harness().open("/settings/general");
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
  await harness().open("/settings/general");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  const signOut = await screen.findByRole("button", { name: "Sign out" }, { timeout: 8000 });
  expect(screen.getByText("Ace Person")).toBeDefined();
  // The browser comes back to this web app's landing page, not the backend's dead end.
  expect(started).toEqual({ returnTo: `${location.origin}/account/signed-in` });
  await userEvent.click(signOut);
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
  await harness().open("/settings/general");
  const signOut = await screen.findByRole("button", { name: "Sign out" });
  await waitFor(() => expect(signOut.hasAttribute("disabled")).toBe(false));
  await userEvent.click(signOut);
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sessionStorage.getItem(`ace.account.session:${origin}`)).toBeNull();
});

test("returning from a cancelled desktop sign-in says so on Profile until the next attempt", async () => {
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", "https://backend.example.com");
  vi.stubGlobal("fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await harness().open("/settings/general?signin=cancelled");
  expect((await screen.findByRole("alert")).textContent).toBe("Sign-in was cancelled.");
  await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(screen.queryByText("Sign-in was cancelled.")).toBeNull());
});
