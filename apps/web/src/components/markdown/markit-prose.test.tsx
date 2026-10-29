import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkitProse } from "./markit-prose.tsx";

describe("markit prose shell stays readable while its worker starts", () => {
  it("keeps the streaming cursor on screen with the renderer", () => {
    const { container } = render(
      <MarkitProse text="**Hello**" tail={<span data-testid="cursor" />} />,
    );
    expect(container.querySelector(".markit-ace")).toBeTruthy();
    expect(screen.getByTestId("cursor")).toBeTruthy();
  });
});
