import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownLoading } from "./loading.tsx";

const reservedHeight = () => {
  const room = screen.getByRole("status", { name: "Loading message" }).firstElementChild;
  if (!room) throw new Error("Loading message has no reserved room");
  return Number.parseFloat(getComputedStyle(room).minHeight);
};

test("a long message reserves more loading room than a short sentence", () => {
  const view = render(<MarkdownLoading text="Short sentence." />);
  const short = reservedHeight();
  view.rerender(<MarkdownLoading text={"A long paragraph ".repeat(100)} />);
  expect(reservedHeight()).toBeGreaterThan(short * 10);
  view.rerender(<MarkdownLoading text={"Short line\n".repeat(30)} />);
  expect(reservedHeight()).toBeGreaterThan(short * 20);
});

test("empty text takes no loading room", () => {
  render(<MarkdownLoading text="" />);
  expect(screen.queryByRole("status", { name: "Loading message" })).toBeNull();
});
