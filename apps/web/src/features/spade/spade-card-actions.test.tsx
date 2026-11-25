import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { CardActions } from "./spade-card.tsx";

test("one filled primary with its key hint sits right of the quiet secondaries, which can be destructive", async () => {
  const save = vi.fn();
  const discard = vi.fn();
  render(
    <CardActions
      primary={{ label: "Save", onClick: save, hint: "enter" }}
      secondary={[
        { label: "Show changes" },
        false,
        { label: "Discard", tone: "danger", onClick: discard },
      ]}
    />,
  );
  const names = screen
    .getAllByRole("button")
    .map((button) => button.textContent?.replace("Enter", ""));
  expect(names).toEqual(["Show changes", "Discard", "Save"]);
  expect(screen.getByRole("button", { name: /Save/ }).querySelector("kbd")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  expect(discard).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
});
