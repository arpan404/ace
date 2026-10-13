import { z } from "zod";

/** The curated badge colours accounts and projects share; clients map each to a theme tint. */
export const BadgeColor = z.enum(["neutral", "blue", "green", "amber", "rose", "violet"]);
export type BadgeColor = z.infer<typeof BadgeColor>;
