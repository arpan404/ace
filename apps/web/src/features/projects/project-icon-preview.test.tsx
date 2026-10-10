import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProjectIconPreview } from "./project-icon-preview.tsx";

test("the detected favicon is read-only and a failed image falls back to project initials", () => {
  const { container } = render(
    <ProjectIconPreview name="Billing API" icon="data:image/png;base64,aGVsbG8=" />,
  );
  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  if (!image) throw new Error("Missing favicon");
  fireEvent.error(image);
  expect(screen.getByText("BA")).toBeTruthy();
});
