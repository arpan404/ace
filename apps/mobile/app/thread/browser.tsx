import React, { useState } from "react";
import { View, StyleSheet, Text, Pressable, TextInput } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { ChevronLeft, Globe, ArrowRight } from "lucide-react-native";
import { useTheme } from "../../src/design/ThemeContext";
import { WebView } from "react-native-webview";

export default function BrowserScreen() {
  const { url: initialUrl } = useLocalSearchParams<{ url?: string }>();
  const { colors } = useTheme();
  const [url, setUrl] = useState(initialUrl ?? "https://");
  const [currentUrl, setCurrentUrl] = useState(initialUrl ?? "");
  const [canGoBack, setCanGoBack] = useState(false);
  const webViewRef = React.useRef<WebView>(null);

  const navigate = () => {
    let target = url.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `https://${target}`;
    }
    setCurrentUrl(target);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Browser",
          headerBackTitleVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.foreground },
        }}
      />

      {/* URL Bar */}
      <View
        style={[
          styles.urlBar,
          {
            backgroundColor: colors.background,
            borderBottomColor: colors.separator,
          },
        ]}
      >
        {canGoBack && (
          <Pressable onPress={() => webViewRef.current?.goBack()} hitSlop={8}>
            <ChevronLeft size={22} color={colors.primary} strokeWidth={2} />
          </Pressable>
        )}
        <View style={[styles.urlInputWrap, { backgroundColor: `${colors.muted}20` }]}>
          <Globe size={14} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.urlInput, { color: colors.foreground }]}
            value={url}
            onChangeText={setUrl}
            placeholder="Enter URL…"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={navigate}
          />
        </View>
        <Pressable onPress={navigate} hitSlop={8}>
          <ArrowRight size={20} color={colors.primary} strokeWidth={2} />
        </Pressable>
      </View>

      {currentUrl ? (
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack);
            if (navState.url) setUrl(navState.url);
          }}
        />
      ) : (
        <View style={styles.placeholder}>
          <Globe size={32} color={colors.muted} strokeWidth={1.5} />
          <Text style={[styles.placeholderText, { color: colors.muted }]}>
            Enter a URL above to browse
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  urlBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  urlInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 10,
    gap: 6,
  },
  urlInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  webview: { flex: 1 },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  placeholderText: { fontSize: 16 },
});
