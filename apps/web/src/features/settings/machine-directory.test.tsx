import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { MachineDirectory } from "./machine-directory.tsx";

test("a hundred machines can be paged and searched without rendering a hundred rows", async () => {
  const machines = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    name: `Worker ${String(index + 1).padStart(3, "0")}`,
  }));
  render(
    <MachineDirectory machines={machines} label="Search machines">
      {(rows) => (
        <ul aria-label="Machines">
          {rows.map((row) => (
            <li key={row.id}>{row.name}</li>
          ))}
        </ul>
      )}
    </MachineDirectory>,
  );
  const list = screen.getByRole("list", { name: "Machines" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(20);
  expect(within(list).getByText("Worker 001")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(within(list).getByText("Worker 021")).toBeTruthy();
  expect(within(list).queryByText("Worker 001")).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search machines" }), "Worker 100");
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(within(list).getByText("Worker 100")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(within(list).getByText("Worker 001")).toBeTruthy();
});
