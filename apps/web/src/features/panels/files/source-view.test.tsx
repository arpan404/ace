import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { SourceView } from "./source-view.tsx";

test("TSX source receives distinct syntax colors after asynchronous highlighting", async () => {
  const code = 'export const App = () => <button title="Hello">{42}</button>;';
  render(<SourceView text={code} lang="tsx" wrap={false} label="Source of app.tsx" />);
  const source = screen.getByRole("region", { name: "Source of app.tsx" });
  await waitFor(() => {
    const tokens = source.querySelectorAll<HTMLElement>('[style*="--source-token-light"]');
    expect(tokens.length).toBeGreaterThan(5);
    expect(
      new Set([...tokens].map((token) => token.style.getPropertyValue("--source-token-light")))
        .size,
    ).toBeGreaterThan(3);
    expect(
      new Set([...tokens].map((token) => token.style.getPropertyValue("--source-token-dark"))).size,
    ).toBeGreaterThan(3);
  });
  expect(source.textContent).toContain(code);
  expect(within(source).queryByRole("alert")).toBeNull();
});
