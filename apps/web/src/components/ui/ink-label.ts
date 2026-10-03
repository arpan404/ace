/**
 * Workaround for default-size primary buttons: `cn` reads the custom `text-ui` font size as a
 * colour and drops `text-primary-foreground`, so the label renders ink on ink. Pass this as
 * `className` until the merge config learns the theme's font sizes (foundation follow-up).
 */
export const inkLabel = "text-[13px] text-primary-foreground";
