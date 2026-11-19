import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { SignInLanding, signInLandingStatus } from "./sign-in-landing.tsx";

test("a browser back from web sign-in says it's signed in and offers to close the tab", async () => {
  let closed = 0;
  render(
    <SignInLanding status={signInLandingStatus("?status=signed-in")} close={() => closed++} />,
  );
  expect(screen.getByRole("heading", { name: "You're signed in to ace" })).toBeDefined();
  expect(screen.getByText(/Go back to the ace tab where you started/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Close tab" }));
  expect(closed).toBe(1);
  // Still here: the browser refused, so the page says how to finish.
  expect(screen.getByRole("status").textContent).toContain("close it yourself");
});

test("a cancelled, expired or unreadable sign-in return never claims to be signed in", () => {
  for (const [search, heading] of [
    ["?status=cancelled", "Sign-in was cancelled"],
    ["?status=expired", "This sign-in expired"],
    ["?status=token", "Couldn't sign in"],
    ["", "Couldn't sign in"],
  ] as const) {
    const { unmount } = render(
      <SignInLanding status={signInLandingStatus(search)} close={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeDefined();
    unmount();
  }
});
