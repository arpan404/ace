import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  House,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { buildBrowserSuggestions, type BrowserSuggestion } from "@ace/shared/browserHistory";
import { normalizeBrowserInput, resolveBrowserHomeUrl } from "@ace/shared/browserUrl";
import { useTheme } from "../../src/design/ThemeContext";
import { Radius, withAlpha } from "../../src/design/system";
import { useMobileBrowserHistoryStore } from "../../src/store/MobileBrowserHistoryStore";
import { useMobileBrowserSessionStore } from "../../src/store/MobileBrowserSessionStore";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";

interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

function newTab(url: string): BrowserTab {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url,
    title: "New tab",
    canGoBack: false,
    canGoForward: false,
  };
}

function titleForUrl(url: string, title?: string): string {
  const cleanedTitle = title?.trim();
  if (cleanedTitle) {
    return cleanedTitle;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export default function BrowserScreen() {
  const { url: initialUrl } = useLocalSearchParams<{ url?: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const searchEngine = useMobilePreferencesStore((state) => state.browserSearchEngine);
  const browserHistory = useMobileBrowserHistoryStore((state) => state.history);
  const recordVisit = useMobileBrowserHistoryStore((state) => state.recordVisit);
  const persistedTabs = useMobileBrowserSessionStore((state) => state.tabs);
  const persistedActiveTabId = useMobileBrowserSessionStore((state) => state.activeTabId);
  const persistBrowserSession = useMobileBrowserSessionStore((state) => state.setSession);
  const homeUrl = resolveBrowserHomeUrl(searchEngine);
  const initialTarget = normalizeBrowserInput(initialUrl ?? "", searchEngine);
  const fallbackTabRef = useRef<BrowserTab>(newTab(initialTarget));
  const [tabs, setTabs] = useState<ReadonlyArray<BrowserTab>>(
    persistedTabs.length > 0 ? persistedTabs : [fallbackTabRef.current],
  );
  const [activeTabId, setActiveTabId] = useState(
    () => persistedActiveTabId ?? tabs[0]?.id ?? fallbackTabRef.current.id,
  );
  const [addressDraft, setAddressDraft] = useState(initialTarget === homeUrl ? "" : initialTarget);
  const [loadingTabId, setLoadingTabId] = useState<string | null>(activeTabId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addressFocused, setAddressFocused] = useState(false);
  const [reloadKeyByTabId, setReloadKeyByTabId] = useState<Record<string, number>>({});
  const [browserSessionHydrated, setBrowserSessionHydrated] = useState(() =>
    useMobileBrowserSessionStore.persist.hasHydrated(),
  );
  const [browserSessionReady, setBrowserSessionReady] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const lastRecordedUrlByTabIdRef = useRef(new Map<string, string>());
  const appliedInitialUrlRef = useRef(false);
  const appliedPersistedSessionRef = useRef(false);

  useEffect(() => {
    const unsubscribe = useMobileBrowserSessionStore.persist.onFinishHydration(() => {
      setBrowserSessionHydrated(true);
    });
    if (useMobileBrowserSessionStore.persist.hasHydrated()) {
      setBrowserSessionHydrated(true);
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!browserSessionHydrated || appliedPersistedSessionRef.current) {
      return;
    }
    appliedPersistedSessionRef.current = true;

    if (persistedTabs.length === 0) {
      persistBrowserSession(tabs, activeTabId);
      appliedInitialUrlRef.current = Boolean(initialUrl);
      setBrowserSessionReady(true);
      return;
    }

    const nextActiveTabId =
      persistedActiveTabId && persistedTabs.some((tab) => tab.id === persistedActiveTabId)
        ? persistedActiveTabId
        : (persistedTabs[0]?.id ?? activeTabId);
    const nextActiveTab = persistedTabs.find((tab) => tab.id === nextActiveTabId);
    setTabs(persistedTabs);
    setActiveTabId(nextActiveTabId);
    setLoadingTabId(nextActiveTabId);
    setLoadError(null);
    setAddressDraft(nextActiveTab?.url === homeUrl ? "" : (nextActiveTab?.url ?? ""));
    setBrowserSessionReady(true);
  }, [
    activeTabId,
    browserSessionHydrated,
    homeUrl,
    initialUrl,
    persistBrowserSession,
    persistedActiveTabId,
    persistedTabs,
    tabs,
  ]);

  useEffect(() => {
    if (!browserSessionReady || appliedInitialUrlRef.current || !initialUrl) {
      return;
    }
    appliedInitialUrlRef.current = true;
    const tab = newTab(initialTarget);
    setTabs((current) => {
      const nextTabs = [...current, tab];
      persistBrowserSession(nextTabs, tab.id);
      return nextTabs;
    });
    setActiveTabId(tab.id);
    setLoadingTabId(tab.id);
    setLoadError(null);
    setAddressDraft(tab.url === homeUrl ? "" : tab.url);
  }, [browserSessionReady, homeUrl, initialTarget, initialUrl, persistBrowserSession]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!,
    [activeTabId, tabs],
  );

  const updateActiveTab = (patch: Partial<BrowserTab>) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== activeTab.id) {
          return tab;
        }
        return { ...tab, ...patch };
      }),
    );
  };

  const commitTabs = (
    resolveNext: (current: ReadonlyArray<BrowserTab>) => ReadonlyArray<BrowserTab>,
    nextActiveTabId: string,
  ) => {
    setTabs((current) => {
      const nextTabs = resolveNext(current);
      persistBrowserSession(nextTabs, nextActiveTabId);
      return nextTabs;
    });
    setActiveTabId(nextActiveTabId);
  };

  const browserSuggestions = useMemo(
    () =>
      buildBrowserSuggestions(addressDraft, {
        activePageUrl: activeTab.url,
        activeTabId: activeTab.id,
        history: browserHistory,
        openTabs: tabs,
        searchEngine,
      }),
    [activeTab.id, activeTab.url, addressDraft, browserHistory, searchEngine, tabs],
  );

  const recordActiveTabVisit = useCallback(() => {
    if (activeTab.url === homeUrl || loadError) {
      return;
    }
    if (lastRecordedUrlByTabIdRef.current.get(activeTab.id) === activeTab.url) {
      return;
    }
    lastRecordedUrlByTabIdRef.current.set(activeTab.id, activeTab.url);
    recordVisit({
      title: activeTab.title,
      url: activeTab.url,
      visitedAt: Date.now(),
      visitCount: 0,
    });
  }, [activeTab.id, activeTab.title, activeTab.url, homeUrl, loadError, recordVisit]);

  const navigate = () => {
    const target = normalizeBrowserInput(addressDraft, searchEngine);
    setLoadError(null);
    setLoadingTabId(activeTab.id);
    updateActiveTab({
      url: target,
      title: titleForUrl(target),
      canGoBack: false,
      canGoForward: false,
    });
    persistBrowserSession(
      tabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: target,
              title: titleForUrl(target),
              canGoBack: false,
              canGoForward: false,
            }
          : tab,
      ),
      activeTab.id,
    );
    setAddressDraft(target === homeUrl ? "" : target);
    setAddressFocused(false);
  };

  const applySuggestion = (suggestion: BrowserSuggestion) => {
    if (suggestion.kind === "tab" && suggestion.tabId) {
      const tab = tabs.find((candidate) => candidate.id === suggestion.tabId);
      if (tab) {
        setActiveTabId(tab.id);
        setLoadError(null);
        setAddressDraft(tab.url === homeUrl ? "" : tab.url);
        setAddressFocused(false);
        return;
      }
    }
    setLoadError(null);
    setLoadingTabId(activeTab.id);
    updateActiveTab({
      url: suggestion.url,
      title: titleForUrl(suggestion.url, suggestion.title),
      canGoBack: false,
      canGoForward: false,
    });
    persistBrowserSession(
      tabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: suggestion.url,
              title: titleForUrl(suggestion.url, suggestion.title),
              canGoBack: false,
              canGoForward: false,
            }
          : tab,
      ),
      activeTab.id,
    );
    setAddressDraft(suggestion.url === homeUrl ? "" : suggestion.url);
    setAddressFocused(false);
  };

  const openNewTab = () => {
    const tab = newTab(homeUrl);
    commitTabs((current) => [...current, tab], tab.id);
    setLoadingTabId(tab.id);
    setLoadError(null);
    setAddressDraft("");
  };

  const closeTab = (tabId: string) => {
    setTabs((current) => {
      if (current.length === 1) {
        const replacement = newTab(homeUrl);
        setActiveTabId(replacement.id);
        persistBrowserSession([replacement], replacement.id);
        setLoadingTabId(replacement.id);
        setLoadError(null);
        setAddressDraft("");
        return [replacement];
      }
      const next = current.filter((tab) => tab.id !== tabId);
      if (tabId === activeTabId) {
        const replacement = next.at(-1)!;
        setActiveTabId(replacement.id);
        persistBrowserSession(next, replacement.id);
        setLoadError(null);
        setAddressDraft(replacement.url === homeUrl ? "" : replacement.url);
      } else {
        persistBrowserSession(next, activeTabId);
      }
      return next;
    });
  };

  const handleNavigationStateChange = (navState: WebViewNavigation) => {
    updateActiveTab({
      url: navState.url,
      title: titleForUrl(navState.url, navState.title),
      canGoBack: navState.canGoBack,
      canGoForward: navState.canGoForward,
    });
    persistBrowserSession(
      tabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: navState.url,
              title: titleForUrl(navState.url, navState.title),
              canGoBack: navState.canGoBack,
              canGoForward: navState.canGoForward,
            }
          : tab,
      ),
      activeTab.id,
    );
    setAddressDraft(navState.url === homeUrl ? "" : navState.url);
  };

  const reloadActiveTab = () => {
    setLoadError(null);
    setLoadingTabId(activeTab.id);
    setReloadKeyByTabId((current) => ({
      ...current,
      [activeTab.id]: (current[activeTab.id] ?? 0) + 1,
    }));
    webViewRef.current?.reload();
  };

  const stopActiveTab = () => {
    webViewRef.current?.stopLoading();
    setLoadingTabId(null);
  };

  const navigateHome = () => {
    setLoadError(null);
    setLoadingTabId(activeTab.id);
    updateActiveTab({
      url: homeUrl,
      title: titleForUrl(homeUrl),
      canGoBack: false,
      canGoForward: false,
    });
    persistBrowserSession(
      tabs.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              url: homeUrl,
              title: titleForUrl(homeUrl),
              canGoBack: false,
              canGoForward: false,
            }
          : tab,
      ),
      activeTab.id,
    );
    setAddressDraft("");
  };

  const openExternal = () => {
    void Linking.openURL(activeTab.url);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View
        style={[
          styles.chrome,
          {
            paddingTop: insets.top + 10,
            backgroundColor: colors.background,
            borderBottomColor: colors.separator,
          },
        ]}
      >
        <View style={styles.navRow}>
          <Pressable
            disabled={!activeTab.canGoBack}
            onPress={() => webViewRef.current?.goBack()}
            style={[
              styles.iconButton,
              { backgroundColor: colors.surfaceSecondary },
              !activeTab.canGoBack && styles.disabled,
            ]}
          >
            <ArrowLeft size={17} color={colors.foreground} strokeWidth={2.2} />
          </Pressable>
          <Pressable
            disabled={!activeTab.canGoForward}
            onPress={() => webViewRef.current?.goForward()}
            style={[
              styles.iconButton,
              { backgroundColor: colors.surfaceSecondary },
              !activeTab.canGoForward && styles.disabled,
            ]}
          >
            <ArrowRight size={17} color={colors.foreground} strokeWidth={2.2} />
          </Pressable>
          <View
            style={[
              styles.addressShell,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
              },
            ]}
          >
            <Search size={14} color={colors.tertiaryLabel} strokeWidth={2.1} />
            <TextInput
              value={addressDraft}
              onChangeText={setAddressDraft}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
              placeholder="Search or enter URL"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={navigate}
              style={[styles.addressInput, { color: colors.foreground }]}
            />
          </View>
          <Pressable
            onPress={navigateHome}
            style={[styles.iconButton, { backgroundColor: colors.surfaceSecondary }]}
            accessibilityRole="button"
            accessibilityLabel="Open browser home"
          >
            <House size={16} color={colors.foreground} strokeWidth={2.2} />
          </Pressable>
          <Pressable
            onPress={loadingTabId === activeTab.id ? stopActiveTab : reloadActiveTab}
            style={[styles.iconButton, { backgroundColor: colors.surfaceSecondary }]}
            accessibilityRole="button"
            accessibilityLabel={loadingTabId === activeTab.id ? "Stop loading page" : "Reload page"}
          >
            {loadingTabId === activeTab.id ? (
              <X size={16} color={colors.foreground} strokeWidth={2.4} />
            ) : (
              <RotateCw size={16} color={colors.foreground} strokeWidth={2.2} />
            )}
          </Pressable>
          <Pressable
            onPress={openNewTab}
            style={[styles.iconButton, { backgroundColor: colors.primary }]}
          >
            <Plus size={17} color={colors.primaryForeground} strokeWidth={2.5} />
          </Pressable>
        </View>

        {addressFocused && browserSuggestions.length > 0 ? (
          <View
            style={[
              styles.suggestionPanel,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
              },
            ]}
          >
            {browserSuggestions.map((suggestion, index) => (
              <Pressable
                key={suggestion.id}
                onPress={() => applySuggestion(suggestion)}
                style={({ pressed }) => [
                  styles.suggestionRow,
                  pressed && { backgroundColor: withAlpha(colors.foreground, 0.04) },
                ]}
              >
                <Search size={14} color={colors.primary} strokeWidth={2.1} />
                <View style={styles.suggestionCopy}>
                  <Text
                    style={[styles.suggestionTitle, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {suggestion.title}
                  </Text>
                  <Text
                    style={[styles.suggestionSubtitle, { color: colors.secondaryLabel }]}
                    numberOfLines={1}
                  >
                    {suggestion.subtitle}
                  </Text>
                </View>
                {index < browserSuggestions.length - 1 ? (
                  <View
                    style={[styles.suggestionSeparator, { backgroundColor: colors.separator }]}
                  />
                ) : null}
              </Pressable>
            ))}
          </View>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabStrip}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab.id;
            return (
              <Pressable
                key={tab.id}
                onPress={() => {
                  setActiveTabId(tab.id);
                  persistBrowserSession(tabs, tab.id);
                  setLoadError(null);
                  setAddressDraft(tab.url === homeUrl ? "" : tab.url);
                }}
                style={[
                  styles.tabChip,
                  {
                    backgroundColor: active ? colors.surface : colors.surfaceSecondary,
                    borderColor: active ? withAlpha(colors.primary, 0.4) : colors.elevatedBorder,
                  },
                ]}
              >
                <Globe size={13} color={active ? colors.primary : colors.secondaryLabel} />
                <Text
                  style={[
                    styles.tabTitle,
                    { color: active ? colors.foreground : colors.secondaryLabel },
                  ]}
                  numberOfLines={1}
                >
                  {tab.title}
                </Text>
                <Pressable onPress={() => closeTab(tab.id)} hitSlop={8}>
                  <X size={13} color={colors.tertiaryLabel} strokeWidth={2.4} />
                </Pressable>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.webviewShell}>
        <WebView
          key={`${activeTab.id}:${reloadKeyByTabId[activeTab.id] ?? 0}`}
          ref={webViewRef}
          source={{ uri: activeTab.url }}
          style={styles.webview}
          allowsBackForwardNavigationGestures
          onLoadStart={() => {
            setLoadingTabId(activeTab.id);
            setLoadError(null);
          }}
          onLoadEnd={() => {
            setLoadingTabId(null);
            recordActiveTabVisit();
          }}
          onError={(event) => {
            setLoadingTabId(null);
            setLoadError(event.nativeEvent.description || "Unable to load this page.");
          }}
          onHttpError={(event) => {
            setLoadingTabId(null);
            setLoadError(`HTTP ${event.nativeEvent.statusCode}`);
          }}
          onNavigationStateChange={handleNavigationStateChange}
        />
        {loadingTabId === activeTab.id ? (
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <View
              style={[
                styles.loadingPill,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            >
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.secondaryLabel }]}>Loading</Text>
            </View>
          </View>
        ) : null}
        {loadError ? (
          <View
            style={[
              styles.errorPanel,
              {
                backgroundColor: colors.background,
              },
            ]}
          >
            <View
              style={[
                styles.errorIcon,
                {
                  backgroundColor: withAlpha(colors.red, 0.12),
                },
              ]}
            >
              <AlertCircle size={22} color={colors.red} strokeWidth={2.2} />
            </View>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>Page did not load</Text>
            <Text style={[styles.errorBody, { color: colors.secondaryLabel }]} numberOfLines={3}>
              {loadError}
            </Text>
            <View style={styles.errorActions}>
              <Pressable
                onPress={reloadActiveTab}
                style={[
                  styles.errorButton,
                  {
                    backgroundColor: colors.primary,
                  },
                ]}
              >
                <RotateCw size={15} color={colors.primaryForeground} strokeWidth={2.3} />
                <Text style={[styles.errorButtonText, { color: colors.primaryForeground }]}>
                  Retry
                </Text>
              </Pressable>
              <Pressable
                onPress={openExternal}
                style={[
                  styles.errorButton,
                  styles.secondaryErrorButton,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <ExternalLink size={15} color={colors.foreground} strokeWidth={2.3} />
                <Text style={[styles.errorButtonText, { color: colors.foreground }]}>
                  Open outside
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  chrome: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingBottom: 9,
  },
  navRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: {
    opacity: 0.42,
  },
  addressShell: {
    flex: 1,
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  addressInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    paddingVertical: 0,
  },
  suggestionPanel: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: Radius.input,
    overflow: "hidden",
  },
  suggestionRow: {
    minHeight: 54,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  suggestionCopy: {
    flex: 1,
    minWidth: 0,
  },
  suggestionTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  suggestionSubtitle: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  suggestionSeparator: {
    position: "absolute",
    left: 36,
    right: 12,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  tabStrip: {
    gap: 8,
    paddingTop: 10,
  },
  tabChip: {
    maxWidth: 180,
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  tabTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  webviewShell: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
  loadingOverlay: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  loadingPill: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  errorPanel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  errorIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  errorTitle: {
    marginTop: 16,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "900",
    textAlign: "center",
  },
  errorBody: {
    marginTop: 8,
    maxWidth: 320,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    textAlign: "center",
  },
  errorActions: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
  },
  errorButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  secondaryErrorButton: {
    borderWidth: 1,
  },
  errorButtonText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "900",
  },
});
