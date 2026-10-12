import data from "../tokens.json" with { type: "json" };
import { DesignTokensSchema } from "./schema.ts";

/** The native JSON export is the source; parsing validates and freezes its typed TS view. */
export const designTokens = DesignTokensSchema.parse(data);
export { DesignTokensSchema } from "./schema.ts";
export type { DesignTokens, ColourScheme, ThemeTokens } from "./schema.ts";
