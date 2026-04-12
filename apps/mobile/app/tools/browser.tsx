import React, { useRef, useState } from "react";
import { Alert, View, StyleSheet, TextInput } from "react-native";
import { Stack } from "expo-router";
import { RotateCcw, ArrowLeft, ArrowRight, Globe } from "lucide-react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/design/ThemeContext";
import { GlassActionButton, GlassGroup, LiquidScreen } from "../../src/design/LiquidGlass";

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

export default function BrowserScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("https://google.com");
  const [inputUrl, setInputUrl] = useState("https://google.com");
  const webViewRef = useRef<WebView>(null);

  const commitUrl = () => {
    try {
      const nextUrl = normalizeUrl(inputUrl);
      if (!nextUrl) {
        return;
      }
      setUrl(nextUrl);
      setInputUrl(nextUrl);
    } catch {
      Alert.alert("Invalid URL", "Enter a valid web address.");
    }
  };

  return (
    <LiquidScreen>
      <Stack.Screen options={{ headerShown: true, title: "", headerBackTitleVisible: false }} />
      <View style={[styles.toolbarWrap, { paddingTop: insets.top > 0 ? 8 : 12 }]}>
        <GlassGroup style={styles.toolbar}>
          <View style={[styles.addressBar, { borderColor: theme.border }]}>
            <Globe size={16} color={theme.mutedForeground} />
            <TextInput
              style={[styles.input, { color: theme.foreground }]}
              value={inputUrl}
              onChangeText={setInputUrl}
              onSubmitEditing={commitUrl}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              placeholder="Search or enter website name"
              placeholderTextColor={theme.mutedForeground}
            />
          </View>
          <View style={styles.controls}>
            <GlassActionButton onPress={() => webViewRef.current?.goBack()}>
              <ArrowLeft size={18} color={theme.foreground} />
            </GlassActionButton>
            <GlassActionButton onPress={() => webViewRef.current?.goForward()}>
              <ArrowRight size={18} color={theme.foreground} />
            </GlassActionButton>
            <GlassActionButton onPress={() => webViewRef.current?.reload()}>
              <RotateCcw size={18} color={theme.foreground} />
            </GlassActionButton>
          </View>
        </GlassGroup>
      </View>

      <WebView ref={webViewRef} source={{ uri: url }} style={styles.webview} />
    </LiquidScreen>
  );
}

const styles = StyleSheet.create({
  toolbarWrap: {
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  toolbar: {
    padding: 10,
    borderRadius: 18,
    gap: 10,
  },
  addressBar: {
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
  },
  controls: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  webview: {
    flex: 1,
  },
});
