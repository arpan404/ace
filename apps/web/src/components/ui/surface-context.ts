import { createContext } from "react";

/*
 * Whether settings rows render on a grouped card (`SettingCard`), where each row insets itself and
 * the card draws hairlines between them. React context crosses portals, so a dialog opened from a
 * row would inherit it; layers that start a new surface (dialogs, sheets) reset it to false.
 */
export const InCard = createContext(false);
