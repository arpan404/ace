import { createContext, useContext, type ReactNode } from "react";
import { Host } from "@expo/ui/jetpack-compose";
import type { StyleProp, ViewStyle, TextStyle } from "react-native";
import { designTokens, type ColourScheme } from "@ace/design-tokens";
import { AceNativeTheme } from "../modules/ace-native/index.tsx";
export const tokens = designTokens;
export const ThemeContext = createContext<ColourScheme>("light");
export function useTheme() {
  return tokens.schemes[useContext(ThemeContext)];
}
export const fontWeights = { 400: "400", 500: "500", 600: "600", 700: "700" } as const;
const themeJson = JSON.stringify(tokens);
export function AceHost({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const scheme = useContext(ThemeContext);
  return (
    <Host
      matchContents={{ vertical: true }}
      style={style}
      colorScheme={scheme}
      seedColor={tokens.schemes[scheme].colours.accent}
      ignoreSafeAreaKeyboardInsets
    >
      <AceNativeTheme tokens={themeJson} dark={scheme === "dark"}>
        {children}
      </AceNativeTheme>
    </Host>
  );
}
export function textStyle(name: keyof typeof tokens.typography.typeScale): TextStyle {
  const t = tokens.typography.typeScale[name];
  return {
    fontFamily: name === "code" ? tokens.typography.monoFamily : tokens.typography.family,
    fontSize: t.size,
    lineHeight: t.lineHeight,
    fontWeight: fontWeights[t.weight],
    letterSpacing: t.letterSpacing,
    includeFontPadding: false,
  };
}
