import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { registerWorkspaceEditorLanguages } from "./workspaceLanguages";

let monacoConfigured = false;

type MonacoThemeMode = "light" | "dark";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function updateLanguageDiagnosticsOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setDiagnosticsOptions = Reflect.get(defaults, "setDiagnosticsOptions");
  if (typeof setDiagnosticsOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "diagnosticsOptions");
  setDiagnosticsOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setOptions = Reflect.get(defaults, "setOptions");
  if (typeof setOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "options");
  setOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function updateLanguageCompilerOptions(
  namespace: unknown,
  defaultsKey: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setCompilerOptions = Reflect.get(defaults, "setCompilerOptions");
  if (typeof setCompilerOptions !== "function") {
    return;
  }
  const current = Reflect.get(defaults, "compilerOptions");
  setCompilerOptions.call(defaults, updater(isRecord(current) ? current : {}));
}

function setLanguageEagerModelSync(
  namespace: unknown,
  defaultsKey: string,
  enabled: boolean,
): void {
  if (!isRecord(namespace)) {
    return;
  }
  const defaults = Reflect.get(namespace, defaultsKey);
  if (!isRecord(defaults)) {
    return;
  }
  const setEagerModelSync = Reflect.get(defaults, "setEagerModelSync");
  if (typeof setEagerModelSync !== "function") {
    return;
  }
  setEagerModelSync.call(defaults, enabled);
}

function readEnumValue(container: unknown, key: string): unknown {
  if (!isRecord(container)) {
    return undefined;
  }
  return Reflect.get(container, key);
}

function rgbChannelToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function alphaToHex(alpha: number): string {
  return Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16)
    .padStart(2, "0");
}

function normalizeResolvedColorToHex(value: string): string | null {
  const match = value
    .trim()
    .match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (!match) {
    return null;
  }
  const red = Number.parseFloat(match[1] ?? "0");
  const green = Number.parseFloat(match[2] ?? "0");
  const blue = Number.parseFloat(match[3] ?? "0");
  const alpha = Number.parseFloat(match[4] ?? "1");
  const base = `#${rgbChannelToHex(red)}${rgbChannelToHex(green)}${rgbChannelToHex(blue)}`;
  return alpha >= 1 ? base : `${base}${alphaToHex(alpha)}`;
}

function withAlpha(hexColor: string, alpha: number): string {
  const trimmed = hexColor.trim();
  const base = trimmed.match(/^#[0-9a-f]{6}$/i) ? trimmed : "#000000";
  return `${base}${alphaToHex(alpha)}`;
}

function resolveThemeCssColor(cssVariableName: string, fallbackHex: string): string {
  if (typeof document === "undefined") {
    return fallbackHex;
  }
  const host = document.body ?? document.documentElement;
  const probe = document.createElement("span");
  probe.style.color = `var(${cssVariableName})`;
  probe.style.position = "absolute";
  probe.style.opacity = "0";
  probe.style.pointerEvents = "none";
  host.appendChild(probe);
  const computed = window.getComputedStyle(probe).color;
  probe.remove();
  return normalizeResolvedColorToHex(computed) ?? fallbackHex;
}

function resolveMonacoThemePalette() {
  const background = resolveThemeCssColor("--background", "#1E1E1E");
  const foreground = resolveThemeCssColor("--foreground", "#D4D4D4");
  const accent = resolveThemeCssColor("--accent", "#2A2D2E");
  const border = resolveThemeCssColor("--border", "#454545");
  const primary = resolveThemeCssColor("--primary", "#4A84CC");
  const mutedForeground = resolveThemeCssColor("--muted-foreground", "#858585");

  return {
    dark: {
      accent,
      background,
      border,
      foreground,
      mutedForeground,
      primary,
    },
    light: {
      accent,
      background,
      border,
      foreground,
      mutedForeground,
      primary,
    },
  };
}

function resolveActiveMonacoThemeMode(): MonacoThemeMode {
  if (typeof document === "undefined") {
    return "dark";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function resolveMonacoThemeName(input?: {
  resolvedTheme?: MonacoThemeMode;
  themePreset?: string | null | undefined;
}): string {
  const resolvedTheme = input?.resolvedTheme ?? resolveActiveMonacoThemeMode();
  const normalizedPreset = (input?.themePreset ?? "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ace-${resolvedTheme}-${normalizedPreset || "default"}`;
}

export function ensureMonacoConfigured(input?: {
  resolvedTheme?: MonacoThemeMode;
  themePreset?: string | null | undefined;
}): string {
  const palette = resolveMonacoThemePalette();
  const resolvedTheme = input?.resolvedTheme ?? resolveActiveMonacoThemeMode();
  const themeName = resolveMonacoThemeName({
    resolvedTheme,
    themePreset: input?.themePreset,
  });

  if (!monacoConfigured) {
    const environment = {
      getWorker(_: string, label: string) {
        switch (label) {
          case "css":
          case "scss":
          case "less":
            return new cssWorker();
          case "html":
          case "handlebars":
          case "razor":
            return new htmlWorker();
          case "json":
            return new jsonWorker();
          case "typescript":
          case "javascript":
            return new tsWorker();
          default:
            return new editorWorker();
        }
      },
    };

    Object.assign(globalThis as object, {
      MonacoEnvironment: environment,
    });
    loader.config({ monaco });
    registerWorkspaceEditorLanguages(monaco);
    const typescriptNamespace = Reflect.get(monaco.languages, "typescript");
    const jsonNamespace = Reflect.get(monaco.languages, "json");
    const cssNamespace = Reflect.get(monaco.languages, "css");
    const moduleKind = readEnumValue(typescriptNamespace, "ModuleKind");
    const moduleResolutionKind = readEnumValue(typescriptNamespace, "ModuleResolutionKind");
    const scriptTarget = readEnumValue(typescriptNamespace, "ScriptTarget");
    const jsxEmit = readEnumValue(typescriptNamespace, "JsxEmit");

    updateLanguageDiagnosticsOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
      ...current,
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
      noSyntaxValidation: true,
    }));
    updateLanguageDiagnosticsOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
      ...current,
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
      noSyntaxValidation: true,
    }));
    updateLanguageCompilerOptions(typescriptNamespace, "javascriptDefaults", (current) => ({
      ...current,
      allowJs: true,
      allowNonTsExtensions: true,
      checkJs: true,
      jsx: readEnumValue(jsxEmit, "ReactJSX") ?? current.jsx,
      module: readEnumValue(moduleKind, "ESNext") ?? current.module,
      moduleResolution: readEnumValue(moduleResolutionKind, "NodeJs") ?? current.moduleResolution,
      noEmit: true,
      resolveJsonModule: true,
      target: readEnumValue(scriptTarget, "ESNext") ?? current.target,
    }));
    updateLanguageCompilerOptions(typescriptNamespace, "typescriptDefaults", (current) => ({
      ...current,
      allowJs: true,
      allowNonTsExtensions: true,
      jsx: readEnumValue(jsxEmit, "ReactJSX") ?? current.jsx,
      module: readEnumValue(moduleKind, "ESNext") ?? current.module,
      moduleResolution: readEnumValue(moduleResolutionKind, "NodeJs") ?? current.moduleResolution,
      noEmit: true,
      resolveJsonModule: true,
      target: readEnumValue(scriptTarget, "ESNext") ?? current.target,
    }));
    setLanguageEagerModelSync(typescriptNamespace, "javascriptDefaults", true);
    setLanguageEagerModelSync(typescriptNamespace, "typescriptDefaults", true);
    updateLanguageDiagnosticsOptions(jsonNamespace, "jsonDefaults", (current) => ({
      ...current,
      schemaRequest: "ignore",
      schemaValidation: "ignore",
      validate: false,
    }));
    updateLanguageOptions(cssNamespace, "cssDefaults", (current) => ({
      ...current,
      validate: false,
    }));
    updateLanguageOptions(cssNamespace, "scssDefaults", (current) => ({
      ...current,
      validate: false,
    }));
    updateLanguageOptions(cssNamespace, "lessDefaults", (current) => ({
      ...current,
      validate: false,
    }));
    monacoConfigured = true;
  }

  const rules =
    resolvedTheme === "dark"
      ? [
          { token: "comment", foreground: "6A9955" },
          { token: "comment.doc", foreground: "7FA36B" },
          { token: "keyword", foreground: "569CD6" },
          { token: "keyword.control", foreground: "C586C0" },
          { token: "annotation", foreground: "D7BA7D" },
          { token: "attribute.name", foreground: "9CDCFE" },
          { token: "attribute.value", foreground: "CE9178" },
          { token: "class-name", foreground: "4EC9B0" },
          { token: "constant", foreground: "4FC1FF" },
          { token: "constructor", foreground: "DCDCAA" },
          { token: "function", foreground: "DCDCAA" },
          { token: "function.call", foreground: "DCDCAA" },
          { token: "invalid", foreground: "F44747" },
          { token: "key", foreground: "9CDCFE" },
          { token: "key.identifier", foreground: "9CDCFE" },
          { token: "namespace", foreground: "4EC9B0" },
          { token: "regexp", foreground: "D16969" },
          { token: "predefined", foreground: "DCDCAA" },
          { token: "string", foreground: "CE9178" },
          { token: "string.escape", foreground: "D7BA7D" },
          { token: "tag", foreground: "569CD6" },
          { token: "tag.name", foreground: "569CD6" },
          { token: "number", foreground: "B5CEA8" },
          { token: "type", foreground: "4EC9B0" },
          { token: "type.identifier", foreground: "4EC9B0" },
          { token: "variable", foreground: "C586C0" },
          { token: "variable.parameter", foreground: "9CDCFE" },
          { token: "delimiter", foreground: "D4D4D4" },
          { token: "delimiter.bracket", foreground: "D4D4D4" },
          { token: "operator", foreground: "D4D4D4" },
        ]
      : [
          { token: "comment", foreground: "008000" },
          { token: "comment.doc", foreground: "4F8A10" },
          { token: "keyword", foreground: "0000FF" },
          { token: "keyword.control", foreground: "AF00DB" },
          { token: "annotation", foreground: "795E26" },
          { token: "attribute.name", foreground: "FF0000" },
          { token: "attribute.value", foreground: "A31515" },
          { token: "class-name", foreground: "267F99" },
          { token: "constant", foreground: "0070C1" },
          { token: "constructor", foreground: "795E26" },
          { token: "function", foreground: "795E26" },
          { token: "function.call", foreground: "795E26" },
          { token: "invalid", foreground: "CD3131" },
          { token: "key", foreground: "0451A5" },
          { token: "key.identifier", foreground: "0451A5" },
          { token: "namespace", foreground: "267F99" },
          { token: "regexp", foreground: "811F3F" },
          { token: "predefined", foreground: "AF00DB" },
          { token: "string", foreground: "A31515" },
          { token: "string.escape", foreground: "EE0000" },
          { token: "tag", foreground: "800000" },
          { token: "tag.name", foreground: "800000" },
          { token: "number", foreground: "098658" },
          { token: "type", foreground: "267F99" },
          { token: "type.identifier", foreground: "267F99" },
          { token: "variable", foreground: "7A3E9D" },
          { token: "variable.parameter", foreground: "001080" },
          { token: "delimiter", foreground: "000000" },
          { token: "delimiter.bracket", foreground: "000000" },
          { token: "operator", foreground: "000000" },
        ];
  const modePalette = resolvedTheme === "dark" ? palette.dark : palette.light;
  monaco.editor.defineTheme(themeName, {
    base: resolvedTheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules,
    colors: {
      "editor.background": modePalette.background,
      "editor.foreground": modePalette.foreground,
      "editor.lineHighlightBackground": withAlpha(
        modePalette.accent,
        resolvedTheme === "dark" ? 0.5 : 0.55,
      ),
      "editor.selectionBackground": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.34 : 0.3,
      ),
      "editor.selectionHighlightBackground": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.2 : 0.18,
      ),
      "editor.selectionHighlightBorder": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.32 : 0.3,
      ),
      "editor.inactiveSelectionBackground": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.18 : 0.14,
      ),
      "editorCursor.foreground": modePalette.foreground,
      "editorWhitespace.foreground": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.2 : 0.22,
      ),
      "editorIndentGuide.background1": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.16 : 0.18,
      ),
      "editorIndentGuide.activeBackground1": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.32 : 0.34,
      ),
      "editorLineNumber.foreground": withAlpha(
        modePalette.mutedForeground,
        resolvedTheme === "dark" ? 0.74 : 0.84,
      ),
      "editorLineNumber.activeForeground": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.9 : 0.92,
      ),
      "editor.wordHighlightBackground": withAlpha(modePalette.primary, 0.16),
      "editor.wordHighlightBorder": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.46 : 0.4,
      ),
      "editor.wordHighlightStrongBackground": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.26 : 0.24,
      ),
      "editor.wordHighlightStrongBorder": withAlpha(
        modePalette.primary,
        resolvedTheme === "dark" ? 0.62 : 0.58,
      ),
      "editorHoverWidget.background": modePalette.background,
      "editorHoverWidget.border": withAlpha(
        modePalette.border,
        resolvedTheme === "dark" ? 0.9 : 0.92,
      ),
      "editorGutter.background": modePalette.background,
      "editorWidget.background": modePalette.background,
      "editorSuggestWidget.background": modePalette.background,
      "editorSuggestWidget.selectedBackground": withAlpha(
        modePalette.accent,
        resolvedTheme === "dark" ? 0.8 : 0.85,
      ),
      "minimap.background": modePalette.background,
      "scrollbarSlider.background": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.14 : 0.12,
      ),
      "scrollbarSlider.hoverBackground": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.24 : 0.2,
      ),
      "scrollbarSlider.activeBackground": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.32 : 0.28,
      ),
      "editorBracketMatch.background": "#0064001A",
      "editorBracketMatch.border": withAlpha(
        modePalette.foreground,
        resolvedTheme === "dark" ? 0.36 : 0.35,
      ),
    },
  });
  monaco.editor.setTheme(themeName);
  return themeName;
}
