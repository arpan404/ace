import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
