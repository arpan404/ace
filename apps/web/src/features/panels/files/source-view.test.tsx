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

test("while text is being edited, untouched lines keep their colours and an edited line shows its new text", async () => {
  const before = "export const first = 1;\nexport const second = 2;";
  const view = render(
    <SourceView text={before} lang="ts" wrap={false} label="Editing" highlightDelay={60_000} />,
  );
  const source = screen.getByRole("region", { name: "Editing" });
  const line = (index: number) => source.querySelector<HTMLElement>(`[data-line="${index}"]`);
  const colored = (index: number) =>
    line(index)?.querySelectorAll('[style*="--source-token-light"]').length ?? 0;
  await waitFor(() => expect(colored(0)).toBeGreaterThan(0));
  view.rerender(
    <SourceView
      text={"export const first = 1;\nexport const changed = 22;"}
      lang="ts"
      wrap={false}
      label="Editing"
      highlightDelay={60_000}
    />,
  );
  // Highlighting waits for typing to settle; the first line's colours stay meanwhile.
  expect(colored(0)).toBeGreaterThan(0);
  expect(colored(1)).toBe(0);
  expect(line(1)?.textContent).toContain("export const changed = 22;");
});
