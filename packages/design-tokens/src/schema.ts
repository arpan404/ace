import { z } from "zod";

const colour = z.string().regex(/^#[0-9A-F]{6}$/);
const size = z.number().finite().nonnegative();
const opacity = z.number().min(0).max(1);
const easing = z.tuple([opacity, z.number().finite(), opacity, z.number().finite()]).readonly();
const typeStyle = z
  .strictObject({
    size: size.positive(),
    lineHeight: size.positive(),
    weight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]),
    letterSpacing: z.number().finite(),
  })
  .readonly();

const scheme = z
  .strictObject({
    colours: z
      .strictObject({
        background: colour,
        secondaryBackground: colour,
        card: colour,
        foreground: colour,
        mutedForeground: colour,
        subtleForeground: colour,
        separator: colour,
        fill: colour,
        glass: colour,
        accent: colour,
        onAccent: colour,
        needsYouSurface: colour,
        diffAdd: colour,
        diffDelete: colour,
        scrim: colour,
        shadow: colour,
      })
      .readonly(),
    status: z
      .strictObject({
        needsYou: colour,
        working: colour,
        waiting: colour,
        unresponsive: colour,
        done: colour,
        failed: colour,
      })
      .readonly(),
    opacity: z
      .strictObject({
        glass: opacity,
        scrim: opacity,
        ripple: opacity,
        disabled: opacity,
        shadow: opacity,
      })
      .readonly(),
  })
  .readonly();

/** Numeric dimensions are logical points/dp; type sizes and line heights scale with text. */
export const DesignTokensSchema = z
  .strictObject({
    version: z.literal(1),
    schemes: z.strictObject({ light: scheme, dark: scheme }).readonly(),
    typography: z
      .strictObject({
        family: z.literal("Inter"),
        monoFamily: z.literal("JetBrains Mono"),
        typeScale: z
          .strictObject({
            caption: typeStyle,
            label: typeStyle,
            body: typeStyle,
            rowTitle: typeStyle,
            title: typeStyle,
            wordmark: typeStyle,
            code: typeStyle,
          })
          .readonly(),
      })
      .readonly(),
    spacing: z
      .strictObject({
        none: size,
        xxs: size,
        xs: size,
        sm: size,
        md: size,
        lg: size,
        xl: size,
        xxl: size,
        xxxl: size,
      })
      .readonly(),
    radii: z
      .strictObject({
        badge: size,
        small: size,
        code: size,
        button: size,
        card: size,
        group: size,
        bubble: size,
        approval: size,
        composer: size,
        sheet: size,
        pill: size,
      })
      .readonly(),
    dimensions: z
      .strictObject({
        touchTarget: size,
        statusDot: size,
        sheetHandleWidth: size,
        sheetHandleHeight: size,
        border: size,
        composerInset: size,
      })
      .readonly(),
    elevation: z.strictObject({ flat: size, card: size, floating: size, sheet: size }).readonly(),
    motion: z
      .strictObject({
        instant: size,
        fast: size,
        standard: size,
        enter: size,
        exit: size,
        statusPulse: size,
        easing: z.strictObject({ standard: easing, enter: easing, exit: easing }).readonly(),
      })
      .readonly(),
  })
  .readonly();

export type DesignTokens = z.infer<typeof DesignTokensSchema>;
export type ColourScheme = keyof DesignTokens["schemes"];
export type ThemeTokens = DesignTokens["schemes"][ColourScheme];
