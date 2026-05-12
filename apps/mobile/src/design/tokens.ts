export const FontFamilies = {
  uiRegular: "System",
  uiMedium: "System",
  uiSemiBold: "System",
  monoRegular: "Menlo",
  monoMedium: "Menlo",
  fallbackSans: "System",
  fallbackMono: "Menlo",
} as const;

export const Typography = {
  fonts: FontFamilies,
  roles: {
    displayLg: {
      fontSize: 32,
      lineHeight: 36,
      letterSpacing: -1.2,
      fontWeight: "800",
      textTransform: "uppercase",
    },
    titleLg: {
      fontSize: 24,
      lineHeight: 28,
      letterSpacing: -0.8,
      fontWeight: "800",
      textTransform: "uppercase",
    },
    titleMd: {
      fontSize: 18,
      lineHeight: 22,
      letterSpacing: -0.5,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    body: {
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0,
      fontWeight: "400",
    },
    bodyStrong: {
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0,
      fontWeight: "600",
    },
    meta: {
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0,
      fontWeight: "500",
      textTransform: "uppercase",
    },
    micro: {
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 0.32,
      fontWeight: "600",
    },
    monoMeta: {
      fontFamily: FontFamilies.monoRegular,
      fontSize: 12,
      lineHeight: 16,
    },
    monoCode: {
      fontFamily: FontFamilies.monoRegular,
      fontSize: 12,
      lineHeight: 18,
    },
  },
} as const;

const lightBase = {
  bg: {
    app: "#FAFAFA",
    canvas: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceMuted: "#F4F4F5",
    surfaceStrong: "#E4E4E7",
    overlay: "rgba(0, 0, 0, 0.05)",
  },
  surfaces: {
    default: "#FFFFFF",
    muted: "#F4F4F5",
    strong: "#E4E4E7",
  },
  text: {
    primary: "#09090B",
    secondary: "#52525B",
    tertiary: "#71717A",
    inverse: "#FFFFFF",
  },
  border: {
    soft: "#E4E4E7",
    strong: "#D4D4D8",
    separator: "#E4E4E7",
  },
  accent: {
    primary: "#18181B",
    soft: "rgba(24, 24, 27, 0.08)",
    strong: "#000000",
  },
  status: {
    success: "#10B981",
    warning: "#F59E0B",
    danger: "#EF4444",
    info: "#3B82F6",
    muted: "#A1A1AA",
  },
  shadow: "rgba(0, 0, 0, 0.08)",
} as const;

const darkBase = {
  bg: {
    app: "#09090B",
    canvas: "#18181B",
    surface: "#18181B",
    surfaceMuted: "#27272A",
    surfaceStrong: "#3F3F46",
    overlay: "rgba(255, 255, 255, 0.05)",
  },
  surfaces: {
    default: "#18181B",
    muted: "#27272A",
    strong: "#3F3F46",
  },
  text: {
    primary: "#FAFAFA",
    secondary: "#A1A1AA",
    tertiary: "#71717A",
    inverse: "#09090B",
  },
  border: {
    soft: "#27272A",
    strong: "#3F3F46",
    separator: "#27272A",
  },
  accent: {
    primary: "#FAFAFA",
    soft: "rgba(250, 250, 250, 0.12)",
    strong: "#FFFFFF",
  },
  status: {
    success: "#34D399",
    warning: "#FBBF24",
    danger: "#F87171",
    info: "#60A5FA",
    muted: "#52525B",
  },
  shadow: "rgba(0, 0, 0, 0.5)",
} as const;

function createCompatTheme<T extends typeof lightBase | typeof darkBase>(palette: T) {
  return {
    ...palette,
    background: palette.bg.app,
    backgroundColor: palette.bg.app,
    foreground: palette.text.primary,
    secondaryLabel: palette.text.secondary,
    tertiaryLabel: palette.text.tertiary,
    separator: palette.border.separator,
    groupedBackground: palette.bg.app,
    secondaryGroupedBackground: palette.bg.canvas,
    primary: palette.accent.primary,
    primaryForeground: palette.text.inverse,
    tint: palette.accent.primary,
    green: palette.status.success,
    orange: palette.status.warning,
    red: palette.status.danger,
    yellow: palette.status.warning,
    muted: palette.status.muted,
    fill: palette.bg.overlay,
    secondaryFill: palette.accent.soft,
    tertiaryFill: palette.bg.surfaceMuted,
    surface: palette.surfaces.default,
    surfaceSecondary: palette.surfaces.muted,
    surfaceTertiary: palette.surfaces.strong,
    card: palette.surfaces.default,
    overlay: palette.bg.overlay,
    elevatedBorder: palette.border.strong,
    accentSoft: palette.accent.soft,
    shadow: palette.shadow,
    backgroundLegacy: palette.bg.app,
  } as const;
}

export const Palette = {
  light: createCompatTheme(lightBase),
  dark: createCompatTheme(darkBase),
} as const;
