import { screen, waitFor } from "@testing-library/react";

/**
 * The window's top bar. A `<header>` inside sectioning content, like the title row of a code
 * block in an answer, isn't a banner landmark (HTML-AAM), though testing-library counts every
 * `<header>` as one.
 */
export function topBar(): HTMLElement {
  const bars = screen
    .queryAllByRole("banner")
    .filter((bar) => !bar.parentElement?.closest("article, aside, main, nav, section"));
  const [bar, ...others] = bars;
  if (!bar || others.length > 0) throw new Error(`Expected one top bar, found ${bars.length}`);
  return bar;
}

/** The top bar, once it shows. */
export const findTopBar = (): Promise<HTMLElement> => waitFor(topBar);
