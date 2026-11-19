import type userEvent from "@testing-library/user-event";

/**
 * The text the code editor inside `container` draws, one line per drawn row, without the
 * line numbers. Only the rows on screen are drawn, so a long file reads as its visible part.
 */
export function editorText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-line-text]"))
    .map((line) => line.textContent ?? "")
    .join("\n");
}

/**
 * Replaces everything in the code editor whose input is `box` with `text`, as a person does:
 * focus it, select all, type. jsdom reports no macOS platform, so select all is Ctrl+A.
 */
export async function replaceEditorText(
  user: ReturnType<typeof userEvent.setup>,
  box: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(box);
  await user.keyboard("{Control>}a{/Control}");
  await user.keyboard(text);
}
