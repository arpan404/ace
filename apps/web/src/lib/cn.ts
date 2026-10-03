import { createCn } from "cn/config";

/**
 * Class merging that knows the app's type scale. Plain `cn` reads unknown `text-*` classes
 * (`text-ui`, `text-md`, `text-prose`, `text-2xs`) as colours, so `text-ui` silently dropped
 * `text-primary-foreground` and primary buttons rendered ink on ink. Import `cn` from here.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["prose", "2xs", "ui", "md"] }] } },
});
