import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import * as Equal from "effect/Equal";
import { useCallback, useMemo } from "react";

import { resetThemePresetToDefault, useAppearancePrefs } from "../../appearancePrefs";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { DEFAULT_THEME_PRESET } from "../../themePresets";
import { PROVIDER_SETTINGS } from "./settingsProviderConfig";

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const { themePreset } = useAppearancePrefs();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(themePreset !== DEFAULT_THEME_PRESET ? ["Theme preset"] : []),
      ...(settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? ["UI font"] : []),
      ...(settings.uiMonoFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiMonoFontFamily
        ? ["Monospace font"]
        : []),
      ...(settings.uiFontSizeScale !== DEFAULT_UNIFIED_SETTINGS.uiFontSizeScale
        ? ["Text size"]
        : []),
      ...(settings.uiLetterSpacing !== DEFAULT_UNIFIED_SETTINGS.uiLetterSpacing
        ? ["Letter spacing"]
        : []),
      ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine
        ? ["Browser search engine"]
        : []),
      ...(settings.browserMaxMountedInstances !==
      DEFAULT_UNIFIED_SETTINGS.browserMaxMountedInstances
        ? ["Max mounted browsers"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.workspaceEditorOpenMode !== DEFAULT_UNIFIED_SETTINGS.workspaceEditorOpenMode
        ? ["Workspace editor open mode"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.editorLineNumbers !== DEFAULT_UNIFIED_SETTINGS.editorLineNumbers
        ? ["Editor line numbers"]
        : []),
      ...(settings.editorMinimap !== DEFAULT_UNIFIED_SETTINGS.editorMinimap
        ? ["Editor minimap"]
        : []),
      ...(settings.editorRenderWhitespace !== DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace
        ? ["Editor whitespace"]
        : []),
      ...(settings.editorStickyScroll !== DEFAULT_UNIFIED_SETTINGS.editorStickyScroll
        ? ["Editor sticky scroll"]
        : []),
      ...(settings.editorSuggestions !== DEFAULT_UNIFIED_SETTINGS.editorSuggestions
        ? ["Editor suggestions"]
        : []),
      ...(settings.editorWordWrap !== DEFAULT_UNIFIED_SETTINGS.editorWordWrap
        ? ["Editor line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.enableToolStreaming !== DEFAULT_UNIFIED_SETTINGS.enableToolStreaming
        ? ["Tool activity"]
        : []),
      ...(settings.enableThinkingStreaming !== DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming
        ? ["Thinking activity"]
        : []),
      ...(settings.hideCompletedWorkMessages !== DEFAULT_UNIFIED_SETTINGS.hideCompletedWorkMessages
        ? ["Completed work details"]
        : []),
      ...(settings.reliabilityUxEnabled !== DEFAULT_UNIFIED_SETTINGS.reliabilityUxEnabled
        ? ["Reliability recovery UX"]
        : []),
      ...(settings.notifyOnAgentCompletion !== DEFAULT_UNIFIED_SETTINGS.notifyOnAgentCompletion
        ? ["Completion notifications"]
        : []),
      ...(settings.notifyOnApprovalRequired !== DEFAULT_UNIFIED_SETTINGS.notifyOnApprovalRequired
        ? ["Approval notifications"]
        : []),
      ...(settings.notifyOnUserInputRequired !== DEFAULT_UNIFIED_SETTINGS.notifyOnUserInputRequired
        ? ["Input notifications"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.gitSshKeyPassphrase !== DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase
        ? ["Git SSH key passphrase"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.providerCliMaxOpen !== DEFAULT_UNIFIED_SETTINGS.providerCliMaxOpen
        ? ["Provider CLI max open"]
        : []),
      ...(settings.providerCliIdleTtlSeconds !== DEFAULT_UNIFIED_SETTINGS.providerCliIdleTtlSeconds
        ? ["Provider CLI idle timeout"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.threadHydrationCacheMemoryMb !==
      DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb
        ? ["Thread cache budget"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      settings.browserMaxMountedInstances,
      settings.browserSearchEngine,
      isGitWritingModelDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.defaultThreadEnvMode,
      settings.gitSshKeyPassphrase,
      settings.addProjectBaseDirectory,
      settings.providerCliIdleTtlSeconds,
      settings.providerCliMaxOpen,
      settings.diffWordWrap,
      settings.editorLineNumbers,
      settings.editorMinimap,
      settings.editorRenderWhitespace,
      settings.editorStickyScroll,
      settings.editorSuggestions,
      settings.editorWordWrap,
      settings.enableAssistantStreaming,
      settings.notifyOnAgentCompletion,
      settings.notifyOnApprovalRequired,
      settings.notifyOnUserInputRequired,
      settings.enableThinkingStreaming,
      settings.enableToolStreaming,
      settings.hideCompletedWorkMessages,
      settings.reliabilityUxEnabled,
      settings.threadHydrationCacheMemoryMb,
      settings.timestampFormat,
      settings.uiFontFamily,
      settings.uiFontSizeScale,
      settings.uiLetterSpacing,
      settings.uiMonoFontFamily,
      settings.workspaceEditorOpenMode,
      theme,
      themePreset,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetThemePresetToDefault();
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}
