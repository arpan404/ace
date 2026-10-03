import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProviderMark } from "./provider-glyph.tsx";

test("Pi threads expose their provider name to assistive technology", () => {
  render(<ProviderMark provider="pi" />);
  expect(screen.getByRole("img", { name: "Pi" }).getAttribute("aria-label")).toBe("Pi");
});
