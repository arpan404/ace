import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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
