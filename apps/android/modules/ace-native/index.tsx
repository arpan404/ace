import { requireNativeView } from "expo";
import type { ReactNode } from "react";
const NativeTheme = requireNativeView<{ tokens: string; dark: boolean; children: ReactNode }>(
  "AceNative",
  "AceTheme",
);
export const AceNativeTheme = NativeTheme;
