import { Text, Button, Shape, Column, Row, Box } from "@expo/ui/jetpack-compose";
import {
  padding,
  size,
  background,
  clip,
  fillMaxWidth,
  weight,
  semantics,
} from "@expo/ui/jetpack-compose/modifiers";
import type { ReactNode } from "react";
import { tokens, useTheme, fontWeights } from "./theme.tsx";

export function AceText({
  children,
  role = "body",
  colour,
  maxLines,
}: {
  children: ReactNode;
  role?: keyof typeof tokens.typography.typeScale;
  colour?: string;
  maxLines?: number;
}) {
  const theme = useTheme();
  const t = tokens.typography.typeScale[role];
  return (
    <Text
      color={colour ?? theme.colours.foreground}
      {...(maxLines ? { maxLines, overflow: "ellipsis" } : {})}
      style={{
        fontFamily: role === "code" ? tokens.typography.monoFamily : tokens.typography.family,
        fontSize: t.size,
        lineHeight: t.lineHeight,
        fontWeight: fontWeights[t.weight],
        letterSpacing: t.letterSpacing,
      }}
    >
      {children}
    </Text>
  );
}
// Expo exposes a pure descriptor factory; its JSX return type loses the required shape brand.
const roundedCorner = Shape.RoundedCorner;
export function AceButton({
  label,
  onPress,
  enabled = true,
  kind = "primary",
}: {
  label: string;
  onPress(): void;
  enabled?: boolean;
  kind?: "primary" | "secondary";
}) {
  const { colours: c } = useTheme();
  const radius = tokens.radii.button;
  return (
    <Button
      onClick={onPress}
      enabled={enabled}
      shape={roundedCorner({
        cornerRadii: {
          topStart: radius,
          topEnd: radius,
          bottomStart: radius,
          bottomEnd: radius,
        },
      })}
      colors={{
        containerColor: kind === "primary" ? c.foreground : c.fill,
        contentColor: kind === "primary" ? c.background : c.foreground,
        disabledContainerColor: c.fill,
        disabledContentColor: c.mutedForeground,
      }}
      contentPadding={{
        start: tokens.spacing.md,
        end: tokens.spacing.md,
        top: tokens.spacing.sm,
        bottom: tokens.spacing.sm,
      }}
      modifiers={[semantics({ contentDescription: label })]}
    >
      <AceText
        colour={enabled ? (kind === "primary" ? c.background : c.foreground) : c.mutedForeground}
      >
        {label}
      </AceText>
    </Button>
  );
}
export function StatusPill({
  label,
  markerColour,
  textColour,
}: {
  label: string;
  markerColour: string;
  textColour: string;
}) {
  return (
    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: tokens.spacing.xs }}>
      <Box
        modifiers={[
          size(tokens.dimensions.statusDot, tokens.dimensions.statusDot),
          clip({ type: "circle" }),
          background(markerColour),
        ]}
      />
      <AceText role="label" colour={textColour}>
        {label}
      </AceText>
    </Row>
  );
}
export function Group({ children }: { children: ReactNode }) {
  const { colours: c } = useTheme();
  return (
    <Column
      modifiers={[
        fillMaxWidth(),
        clip({ type: "roundedCorner", radius: tokens.radii.group }),
        background(c.secondaryBackground),
        padding(tokens.spacing.md, tokens.spacing.md, tokens.spacing.md, tokens.spacing.md),
      ]}
      verticalArrangement={{ spacedBy: tokens.spacing.md }}
    >
      {children}
    </Column>
  );
}
export { Column, Row, Box, padding, size, background, clip, fillMaxWidth, weight };
