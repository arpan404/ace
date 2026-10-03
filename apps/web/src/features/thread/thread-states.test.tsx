import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("a thread the daemon doesn't have says so and offers the way back", async () => {
  await harness().open("/t/thread-that-was-deleted");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This thread couldn't be loaded");
  expect(screen.getByRole("link", { name: "Back to Home" })).toBeTruthy();
});
