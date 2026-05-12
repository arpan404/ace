import React from "react";
import {
  Text as RNText,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
} from "react-native";

type ExpoTextProps = RNTextProps & {
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
};

export function ExpoText({ children, style, numberOfLines, ...restProps }: ExpoTextProps) {
  if (children == null) {
    return null;
  }

  return (
    <RNText {...restProps} style={style} numberOfLines={numberOfLines}>
      {children}
    </RNText>
  );
}
