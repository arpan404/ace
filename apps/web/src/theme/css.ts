import type { Theme } from "./presets.ts";
import { statusTextColours } from "./status-text.ts";

/**
 * One theme as a CSS rule scoped to `[data-theme="<id>"]`. Foreground aliases are emitted
 * here so components only ever read shadcn token names, and each status hue as readable text.
 */
export function themeRule(theme: Theme): string {
  const t = theme.tokens;
  const declarations: Record<string, string> = {
    "color-scheme": theme.scheme,
    ...t,
    "--card-foreground": t["--foreground"],
    "--popover-foreground": t["--foreground"],
    "--secondary-foreground": t["--foreground"],
    "--accent-foreground": t["--foreground"],
    "--sidebar-primary": t["--foreground"],
    "--sidebar-primary-foreground": t["--primary-foreground"],
    "--sidebar-accent-foreground": t["--foreground"],
    ...statusTextColours(theme),
  };
  const body = Object.entries(declarations)
    .map(([name, value]) => `${name}:${sanitize(value)}`)
    .join(";");
  return `[data-theme="${cssString(theme.id)}"]{${body}}`;
}

export function themeStylesheet(themes: readonly Theme[]): string {
  return themes.map(themeRule).join("\n");
}

/** Imported themes are user data: a value can never close the rule or open another. */
function sanitize(value: string): string {
  return value.replace(/[{};<>]/g, "");
}
function cssString(value: string): string {
  return value.replace(/["\\]/g, "");
}
