import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let monacoConfigured = false;

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

export function ensureMonacoConfigured(): void {
  if (monacoConfigured) {
    return;
  }

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
  monaco.editor.defineTheme("ace-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "keyword", foreground: "569CD6" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "type", foreground: "4EC9B0" },
      { token: "delimiter", foreground: "D4D4D4" },
    ],
    colors: {
      "editor.background": "#1E1E1E",
      "editor.foreground": "#D4D4D4",
      "editor.lineHighlightBackground": "#2A2D2E",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#3A3D41",
      "editorCursor.foreground": "#AEAFAD",
      "editorWhitespace.foreground": "#3B3B3B",
      "editorIndentGuide.background1": "#404040",
      "editorIndentGuide.activeBackground1": "#707070",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#C6C6C6",
      "editorBracketMatch.background": "#0064001A",
      "editorBracketMatch.border": "#888888",
    },
  });
  monaco.editor.defineTheme("ace-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "008000" },
      { token: "keyword", foreground: "0000FF" },
      { token: "string", foreground: "A31515" },
      { token: "number", foreground: "098658" },
      { token: "type", foreground: "267F99" },
      { token: "delimiter", foreground: "000000" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#000000",
      "editor.lineHighlightBackground": "#F7F7F7",
      "editor.selectionBackground": "#ADD6FF",
      "editor.inactiveSelectionBackground": "#E5EBF1",
      "editorCursor.foreground": "#000000",
      "editorWhitespace.foreground": "#D0D0D0",
      "editorIndentGuide.background1": "#D3D3D3",
      "editorIndentGuide.activeBackground1": "#939393",
      "editorLineNumber.foreground": "#237893",
      "editorLineNumber.activeForeground": "#0B216F",
      "editorBracketMatch.background": "#0064001A",
      "editorBracketMatch.border": "#B9B9B9",
    },
  });
  monacoConfigured = true;
}
