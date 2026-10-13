import { createContext, useContext, type ReactNode } from "react";

/*
 * One glass layer at a time (Apple: "always avoid glass on glass"). Floating layers portal to the
 * body, so a menu opened from a popover is not inside it in the DOM and CSS can't tell they
 * stack; React context crosses portals, so it can. A glass layer marks its contents, and any
 * floating layer opened from them is solid. A layer that starts a solid surface (a dialog)
 * clears the mark, so its own popups may be glass again.
 */
const OnGlass = createContext(false);

/** The class for a floating layer opened here: glass, unless it would sit on glass. */
export function useFloatingMaterial(): "ace-floating" | "ace-floating-solid" {
  return useContext(OnGlass) ? "ace-floating-solid" : "ace-floating";
}

/** Wraps a floating layer's contents: layers opened from inside `glass` contents are solid. */
export function FloatingContents(props: { glass: boolean; children?: ReactNode }) {
  return <OnGlass.Provider value={props.glass}>{props.children}</OnGlass.Provider>;
}
