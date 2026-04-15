import React, { useState } from "react";
import { View, StyleSheet, Text, Pressable, TextInput } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
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
            backgroundColor: colors.secondaryGroupedBackground,
            borderBottomColor: colors.separator,
          },
        ]}
      >
        {canGoBack && (
          <Pressable onPress={() => webViewRef.current?.goBack()} style={styles.navButton}>
            <Text style={[styles.navButtonText, { color: colors.primary }]}>‹</Text>
          </Pressable>
        )}
        <TextInput
          style={[
            styles.urlInput,
            {
              backgroundColor: colors.fill,
              color: colors.foreground,
            },
          ]}
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
        <Pressable onPress={navigate} style={styles.goButton}>
          <Text style={[styles.goButtonText, { color: colors.primary }]}>Go</Text>
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
    gap: 8,
  },
  navButton: { paddingHorizontal: 4 },
  navButtonText: { fontSize: 28, fontWeight: "300" },
  urlInput: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  goButton: { paddingHorizontal: 8 },
  goButtonText: { fontSize: 16, fontWeight: "600" },
  webview: { flex: 1 },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  placeholderText: { fontSize: 16 },
});
