import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { componentClient } from "@/test/component-client.tsx";
import { SignInHost, useSignIn } from "./sign-in-host.tsx";

// The login's code arrives only when the test lets it, as on a slow connection.
const arrival = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./login-controller.ts", async (importOriginal) => {
  await arrival.promise;
  return importOriginal();
});

function SignInCodex() {
  const signIn = useSignIn();
  return (
    <button type="button" onClick={() => signIn?.({ provider: "codex" })}>
      Sign in
    </button>
  );
}

test("clicks made while the sign-in code loads start one login, and it signs in", async () => {
  const user = userEvent.setup();
  const app = await componentClient({
    thread: { id: "sign-in", workspaceId: "relay", provider: "codex", title: "Sign in" },
    steps: [],
  });
  app.render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInHost>
        <SignInCodex />
      </SignInHost>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  arrival.resolve();
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Sign in to Codex" },
    { timeout: 5_000 },
  );
  expect(dialog).toBeTruthy();
  // Only the last click started a login: the daemon's first sign-in is the one on screen.
  app.daemon.services.providerLogin.complete("fake-login-1");
  expect(await screen.findByText("Signed in to Codex")).toBeTruthy();
}, 15_000);
