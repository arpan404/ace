/**
 * The app's additions to Tailwind's class groups. Plain `cn` reads unknown `text-*` classes
 * (`text-ui`, `text-md`, `text-prose`, `text-2xs`) as colours, so `text-ui` silently dropped
 * `text-primary-foreground` and primary buttons rendered ink on ink. The merge tables are compiled
 * from this (`scripts/cn-tables.ts`).
 */
export const cnExtension = {
  extend: { classGroups: { "font-size": [{ text: ["prose", "2xs", "ui", "md"] }] } },
};
