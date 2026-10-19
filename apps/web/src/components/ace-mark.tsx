import type { ComponentProps } from "react";

/**
 * One wing of the ace mark on its 24-unit grid; the mark is it and its mirror image. The app
 * icon (apps/desktop/build/icon.svg), the menu-bar icon and the first paint (`index.html`)
 * draw the same path.
 */
export const aceWing =
  "M11.6 2C10.8 2 10.4 2.6 9.8 3.3L2.9 11.3C1.2 13.3 1.8 15.6 3.8 16.8L7.8 19.3C8.5 19.8 9.3 19.8 9.9 19.1L11 17.7C11.7 16.8 11.5 16.1 10.8 15.4L7.3 12.3C10.3 9.8 11.6 7.6 11.6 5V2Z";

/** The mark's two wings, for an SVG on the 24-unit grid. */
export function AceWings() {
  return (
    <>
      <path d={aceWing} />
      <path transform="translate(24 0) scale(-1 1)" d={aceWing} />
    </>
  );
}

/** Mirrored wings gather around an open diamond; the mark follows its surface's colour. */
export function AceMark(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <AceWings />
    </svg>
  );
}
