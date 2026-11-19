import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, test } from "vitest";
import { ErrorRow } from "./error-row.tsx";

/** The row alone, where no sign-in dialog is mounted, so Sign in has to link to Settings. */
async function renderRow(text: string) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ErrorRow error={{ text }} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByRole("link", { name: "Sign in" });
}

test("a signed-out provider's Sign in opens that provider's page in Settings", async () => {
  const link = await renderRow("[claude-code:not_signed_in] Sign in to Claude Code and retry.");
  expect(link.getAttribute("href")).toBe("/settings/providers/claude");
});
