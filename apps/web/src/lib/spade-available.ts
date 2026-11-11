/**
 * Whether this build includes Spade. Built with `DISABLE_SPADE=1`, the app leaves Spade's
 * screens, routes and settings out and shows its rail mark as coming soon.
 */
export const spadeAvailable: boolean = import.meta.env.VITE_ACE_SPADE !== "off";
