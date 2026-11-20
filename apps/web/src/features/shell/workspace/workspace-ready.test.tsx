import { render, screen } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { defineWorkspace } from "@/lib/workspace/index.ts";
import { WhenKindsReady } from "./workspace.tsx";

test("failed tool loading is visible and retries the requested content without a reload", async () => {
  const kinds = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ default: [] });
  const definition = defineWorkspace({ label: "Tools", launcher: "launcher", initial: [], kinds });
  render(
    <WhenKindsReady definition={definition} visible>
      <p>Requested tool</p>
    </WhenKindsReady>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Tools couldn't load.");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Requested tool")).toBeTruthy();
  expect(kinds).toHaveBeenCalledTimes(2);
});

test("switching workspaces waits for the new workspace's own tools", async () => {
  const first = defineWorkspace({
    label: "Threads",
    launcher: "new",
    initial: [],
    kinds: async () => ({ default: [] }),
  });
  await first.load();
  const pending = Promise.withResolvers<{ default: [] }>();
  const second = defineWorkspace({
    label: "Pull requests",
    launcher: "pr-new",
    initial: [],
    kinds: () => pending.promise,
  });
  const view = render(
    <WhenKindsReady definition={first} visible>
      <p>Thread tools</p>
    </WhenKindsReady>,
  );
  await screen.findByText("Thread tools");
  view.rerender(
    <WhenKindsReady definition={second} visible>
      <p>Pull request tools</p>
    </WhenKindsReady>,
  );
  expect(screen.queryByText("Pull request tools")).toBeNull();
  expect(screen.getByRole("status", { name: "Loading tools" })).toBeTruthy();
  pending.resolve({ default: [] });
  await screen.findByText("Pull request tools");
});

test("the panel shows its loading state, not a suspended fallback, until its own code has loaded", async () => {
  const definition = defineWorkspace({
    label: "Tools",
    launcher: "launcher",
    initial: [],
    kinds: async () => ({ default: [] }),
  });
  await definition.load();
  const code = Promise.withResolvers<() => ReactNode>();
  const Panel = deferredComponent(() => code.promise);
  render(
    <Suspense fallback={<p>Suspended</p>}>
      <WhenKindsReady definition={definition} visible code={Panel}>
        <Panel.Component />
      </WhenKindsReady>
    </Suspense>,
  );
  expect(screen.getByRole("status", { name: "Loading tools" })).toBeTruthy();
  expect(screen.queryByText("Suspended")).toBeNull();
  code.resolve(() => <p>Panel tabs</p>);
  await screen.findByText("Panel tabs");
  expect(screen.queryByText("Suspended")).toBeNull();
});
