import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { ReviewerField } from "./reviewer-field.tsx";

function Form() {
  const [value, setValue] = useState("");
  return (
    <>
      <ReviewerField onChange={setValue} />
      <output aria-label="Reviewers to send">{value}</output>
    </>
  );
}

test("Enter and comma add reviewers that can be removed again", async () => {
  render(<Form />);
  const field = screen.getByRole("textbox", { name: "Reviewers" });
  await userEvent.type(field, "alice{Enter}bob,");
  expect(screen.getByRole("button", { name: "Remove reviewer alice" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove reviewer bob" })).toBeTruthy();
  expect(screen.getByRole("status", { name: "Reviewers to send" }).textContent).toBe(
    "alice, bob, ",
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove reviewer alice" }));
  expect(screen.getByRole("status", { name: "Reviewers to send" }).textContent).toBe("bob, ");
});

test("Backspace removes the last reviewer only when the draft is empty", async () => {
  render(<Form />);
  const field = screen.getByRole("textbox", { name: "Reviewers" });
  await userEvent.type(field, "alice{Enter}bob{Backspace}");
  expect(screen.getByRole("button", { name: "Remove reviewer alice" })).toBeTruthy();
  await userEvent.clear(field);
  await userEvent.keyboard("{Backspace}");
  expect(screen.queryByRole("button", { name: "Remove reviewer alice" })).toBeNull();
  expect(screen.getByRole("status", { name: "Reviewers to send" }).textContent).toBe("");
});
