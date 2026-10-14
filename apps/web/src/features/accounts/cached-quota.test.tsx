import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { WindowBar } from "./window-bar.tsx";

const now = Date.parse("2026-10-09T12:00:00Z");
test("an expired cached five-hour window never presents its old percentage as current usage", () => {
  render(
    <WindowBar
      window={{
        id: "five_hour",
        label: "5-hour",
        usedPercent: 5,
        resetsAt: Date.parse("2026-10-07T01:00:00Z"),
      }}
      now={now}
    />,
  );
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText("5%")).toBeNull();
  expect(screen.queryByText("0%")).toBeNull();
  expect(screen.queryByText("Resets now")).toBeNull();
  expect(screen.getByText("Waiting for a new provider reading")).toBeTruthy();
});
