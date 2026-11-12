import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

// The machine pages' lazy bodies must be transformed before the first deadline starts.
await import("./agents-page.tsx");

test("Settings stays quiet when this window's client closes underneath it", async () => {
  const app = harness({
    machines: [{ hostId: "build", name: "Build server" }],
    throughWorker: true,
  });
  await app.open("/settings/agents");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: / }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /Build server$/ }));
  await screen.findByRole("switch", { name: "New threads use a worktree" });

  // Anything React reports from here on: a throw from an effect, or a render loop it cut off.
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  // This window's own client goes (sign-out, a reconnect replacing it) while the page is mounted.
  await app.client.close();
  // Back to this window's machine: the banner, the notices and the settings the page reads all
  // subscribe again, now to the closed client.
  await userEvent.click(await screen.findByRole("button", { name: /^Environment: / }));
  const [own] = await screen.findAllByRole("menuitemradio");
  if (!own) throw new Error("No machines offered");
  await userEvent.click(own);
  await new Promise((settled) => setTimeout(settled, 200));

  expect(errors).not.toHaveBeenCalled();
  // The page is still there, with nothing from the closed client.
  expect(screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: /^Environment: / })).toBeTruthy();
}, 30_000);
