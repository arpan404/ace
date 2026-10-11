import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

test("an unknown address keeps the shell and says the page doesn't exist", async () => {
  await harness().open("/this/does/not/exist");
  const main = await screen.findByRole("main");
  expect(within(main).getByRole("heading", { name: "This page doesn't exist" })).toBeTruthy();
  expect(within(main).getByText("/this/does/not/exist")).toBeTruthy();
  // The app's chrome is still there to go elsewhere.
  expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  await userEvent.click(within(main).getByRole("link", { name: "Go to Home" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "This page doesn't exist" })).toBeNull(),
  );
});

test("after following a rail link, focus lands on the new view's title", async () => {
  const user = userEvent.setup();
  await harness().open("/new");
  await user.click(await screen.findByRole("link", { name: "Settings" }));
  await waitFor(() => {
    const focused = document.activeElement;
    expect(focused?.tagName).toBe("H1");
    expect(focused?.textContent).toBe("Settings");
    expect(focused?.closest("header")).not.toBeNull();
  });
});

test.each(["trigger", "item"])(
  "navigation focus preserves an open profile menu's %s focus",
  async (focus) => {
    await harness().open("/settings/providers");
    await screen.findByRole("region", { name: "Installed providers" });
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const schedule = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.set(++id, callback);
        return id;
      });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const flushFrames = () =>
      act(async () => {
        const pending = new Map(frames);
        for (const [frame, callback] of pending) {
          if (frames.delete(frame)) callback(0);
        }
      });
    try {
      await userEvent.click(screen.getByRole("link", { name: "Back to app" }));
      await screen.findByRole("heading", { level: 1, name: "New thread" });
      await userEvent.click(screen.getByRole("button", { name: /^You, account/ }));
      await screen.findByRole("menuitem", { name: "Usage" });
      if (focus === "item") {
        await userEvent.keyboard("{ArrowDown}");
        await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitem"));
      } else {
        expect(document.activeElement).toBe(screen.getByRole("button", { name: /^You, account/ }));
      }
      // Run the actual navigation frame after the person's next interaction, as a busy
      // renderer can. The route's title must not steal focus and dismiss the open menu.
      await flushFrames();
      expect(screen.getByRole("menuitem", { name: "Usage" })).toBeTruthy();
      await userEvent.click(screen.getByRole("menuitem", { name: "Usage" }));
      const title = await screen.findByRole("heading", { level: 1, name: "Usage" });
      await flushFrames();
      expect(document.activeElement).toBe(title);
    } finally {
      schedule.mockRestore();
      cancel.mockRestore();
    }
  },
);
