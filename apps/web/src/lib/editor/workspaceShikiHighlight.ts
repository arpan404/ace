import { Facet, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  createBundledHighlighter,
  type HighlighterGeneric,
  type LanguageInput,
  type ThemeInput,
  type TokenStyles,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const WORKSPACE_SHIKI_THEME_IDS = {
  dark: "github-dark-default",
  light: "github-light-default",
} as const;

const WORKSPACE_SHIKI_HIGHLIGHT_DEBOUNCE_MS = 120;
const WORKSPACE_SHIKI_MAX_DOCUMENT_LENGTH = 512_000;
const WORKSPACE_SHIKI_TOKENIZE_MAX_LINE_LENGTH = 2_000;
const WORKSPACE_SHIKI_TOKENIZE_TIME_LIMIT_MS = 80;
const WORKSPACE_SHIKI_TOKEN_STYLE_CACHE_MAX_SIZE = 768;
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

const workspaceShikiLanguages = {
  bat: () => import("shiki/langs/bat.mjs"),
  cjs: () => import("shiki/langs/cjs.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  cts: () => import("shiki/langs/cts.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/js.mjs"),
  js: () => import("shiki/langs/js.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  md: () => import("shiki/langs/md.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  mjs: () => import("shiki/langs/mjs.mjs"),
  mts: () => import("shiki/langs/mts.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ts: () => import("shiki/langs/ts.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/ts.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} as const satisfies Record<string, LanguageInput>;

type WorkspaceShikiTheme =
  (typeof WORKSPACE_SHIKI_THEME_IDS)[keyof typeof WORKSPACE_SHIKI_THEME_IDS];
type WorkspaceBundledLanguage = keyof typeof workspaceShikiLanguages;
type WorkspaceShikiLanguage = WorkspaceBundledLanguage | "text";
type WorkspaceShikiHighlighter = HighlighterGeneric<WorkspaceBundledLanguage, WorkspaceShikiTheme>;

const workspaceShikiThemes = {
  [WORKSPACE_SHIKI_THEME_IDS.dark]: () => import("shiki/themes/github-dark-default.mjs"),
  [WORKSPACE_SHIKI_THEME_IDS.light]: () => import("shiki/themes/github-light-default.mjs"),
} as const satisfies Record<WorkspaceShikiTheme, ThemeInput>;

interface WorkspaceShikiHighlightConfig {
  readonly key: string;
  readonly language: WorkspaceShikiLanguage | null;
  readonly theme: WorkspaceShikiTheme;
}

interface WorkspaceShikiDecorationsEffect {
  readonly decorations: DecorationSet;
  readonly key: string;
}

const createWorkspaceShikiHighlighter = createBundledHighlighter({
  engine: () => createJavaScriptRegexEngine(),
  langs: workspaceShikiLanguages,
  themes: workspaceShikiThemes,
});

const workspaceShikiLanguageLookup = workspaceShikiLanguages as Readonly<Record<string, unknown>>;
const tokenDecorationCache = new Map<string, Decoration>();
const loadedLanguages = new Set<WorkspaceShikiLanguage>();
const loadingLanguages = new Map<WorkspaceShikiLanguage, Promise<void>>();

let highlighterPromise: Promise<WorkspaceShikiHighlighter> | null = null;

const defaultWorkspaceShikiHighlightConfig: WorkspaceShikiHighlightConfig = {
  key: "none:github-light-default",
  language: null,
  theme: WORKSPACE_SHIKI_THEME_IDS.light,
};

const workspaceShikiHighlightConfigFacet = Facet.define<
  WorkspaceShikiHighlightConfig,
  WorkspaceShikiHighlightConfig
>({
  combine(values) {
    return values.length > 0 ? values[values.length - 1]! : defaultWorkspaceShikiHighlightConfig;
  },
});

const setWorkspaceShikiDecorations = StateEffect.define<WorkspaceShikiDecorationsEffect>();

const workspaceShikiHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    const previousConfig = transaction.startState.facet(workspaceShikiHighlightConfigFacet);
    const nextConfig = transaction.state.facet(workspaceShikiHighlightConfigFacet);
    let next =
      previousConfig.key === nextConfig.key ? value.map(transaction.changes) : Decoration.none;

    for (const effect of transaction.effects) {
      if (effect.is(setWorkspaceShikiDecorations) && effect.value.key === nextConfig.key) {
        next = effect.value.decorations;
      }
    }

    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class WorkspaceShikiHighlightPlugin {
  private requestToken = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    this.scheduleHighlight(0);
  }

  update(update: ViewUpdate): void {
    const previousConfig = update.startState.facet(workspaceShikiHighlightConfigFacet);
    const nextConfig = update.state.facet(workspaceShikiHighlightConfigFacet);
    if (update.docChanged || previousConfig.key !== nextConfig.key) {
      this.scheduleHighlight(WORKSPACE_SHIKI_HIGHLIGHT_DEBOUNCE_MS);
    }
  }

  destroy(): void {
    this.requestToken += 1;
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private scheduleHighlight(delayMs: number): void {
    this.requestToken += 1;
    const requestToken = this.requestToken;

    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.highlight(requestToken);
    }, delayMs);
  }

  private async highlight(requestToken: number): Promise<void> {
    const config = this.view.state.facet(workspaceShikiHighlightConfigFacet);
    const code = this.view.state.doc.toString();

    if (!config.language || code.length > WORKSPACE_SHIKI_MAX_DOCUMENT_LENGTH) {
      this.dispatchDecorations(config.key, Decoration.none, requestToken);
      return;
    }

    const highlighter = await getWorkspaceShikiHighlighter(config.language);
    if (!highlighter || this.requestToken !== requestToken) {
      return;
    }

    try {
      const result = highlighter.codeToTokens(code, {
        lang: config.language,
        theme: config.theme,
        tokenizeMaxLineLength: WORKSPACE_SHIKI_TOKENIZE_MAX_LINE_LENGTH,
        tokenizeTimeLimit: WORKSPACE_SHIKI_TOKENIZE_TIME_LIMIT_MS,
      });
      const decorations = createWorkspaceShikiDecorations(result.tokens, code.length);
      this.dispatchDecorations(config.key, decorations, requestToken);
    } catch (error) {
      console.warn(
        `Workspace editor Shiki highlighting failed for language "${config.language}".`,
        error instanceof Error ? error.message : error,
      );
      this.dispatchDecorations(config.key, Decoration.none, requestToken);
    }
  }

  private dispatchDecorations(key: string, decorations: DecorationSet, requestToken: number): void {
    if (this.requestToken !== requestToken) {
      return;
    }

    this.view.dispatch({
      effects: setWorkspaceShikiDecorations.of({ decorations, key }),
    });
  }
}

const workspaceShikiHighlightPlugin = ViewPlugin.fromClass(WorkspaceShikiHighlightPlugin);
const workspaceShikiHighlightSupportExtension: Extension = [
  workspaceShikiHighlightField,
  workspaceShikiHighlightPlugin,
];

export function createWorkspaceShikiHighlightConfig(input: {
  readonly filePath: string | null;
  readonly languageId: string | null | undefined;
  readonly resolvedTheme: "light" | "dark";
}): Extension {
  const language = resolveWorkspaceShikiLanguage(input);
  const theme = WORKSPACE_SHIKI_THEME_IDS[input.resolvedTheme];
  return workspaceShikiHighlightConfigFacet.of({
    key: `${language ?? "none"}:${theme}`,
    language,
    theme,
  });
}

export function workspaceShikiHighlightSupport(): Extension {
  return workspaceShikiHighlightSupportExtension;
}

export function resolveWorkspaceShikiLanguage(input: {
  readonly filePath: string | null;
  readonly languageId: string | null | undefined;
}): WorkspaceShikiLanguage | null {
  const languageId = input.languageId?.toLowerCase();
  if (!languageId) {
    return null;
  }

  const filePath = input.filePath?.toLowerCase() ?? "";
  const mappedLanguage = mapWorkspaceLanguageToShikiLanguage(languageId, filePath);
  if (mappedLanguage && isBundledShikiLanguage(mappedLanguage)) {
    return mappedLanguage;
  }

  return null;
}

export function createWorkspaceShikiTokenStyle(input: TokenStyles): string | null {
  const styleParts: string[] = [];

  if (input.color) {
    styleParts.push(`color: ${input.color}`);
  }
  if (input.bgColor) {
    styleParts.push(`background-color: ${input.bgColor}`);
  }
  if (typeof input.fontStyle === "number" && input.fontStyle > 0) {
    const textDecorationLines: string[] = [];
    if ((input.fontStyle & FONT_STYLE_ITALIC) !== 0) {
      styleParts.push("font-style: italic");
    }
    if ((input.fontStyle & FONT_STYLE_BOLD) !== 0) {
      styleParts.push("font-weight: 700");
    }
    if ((input.fontStyle & FONT_STYLE_UNDERLINE) !== 0) {
      textDecorationLines.push("underline");
    }
    if ((input.fontStyle & FONT_STYLE_STRIKETHROUGH) !== 0) {
      textDecorationLines.push("line-through");
    }
    if (textDecorationLines.length > 0) {
      styleParts.push(`text-decoration-line: ${textDecorationLines.join(" ")}`);
    }
  }

  return styleParts.length > 0 ? styleParts.join("; ") : null;
}

function mapWorkspaceLanguageToShikiLanguage(languageId: string, filePath: string): string | null {
  switch (languageId) {
    case "typescript":
      if (filePath.endsWith(".tsx")) return "tsx";
      if (filePath.endsWith(".mts")) return "mts";
      if (filePath.endsWith(".cts")) return "cts";
      return "typescript";
    case "javascript":
      if (filePath.endsWith(".jsx")) return "jsx";
      if (filePath.endsWith(".mjs")) return "mjs";
      if (filePath.endsWith(".cjs")) return "cjs";
      return "javascript";
    case "json":
      return filePath.endsWith(".jsonc") ? "jsonc" : "json";
    case "dockerfile":
      return "docker";
    case "ini":
      return filePath.endsWith(".toml") ? "toml" : "ini";
    case "markdown":
      return "md";
    case "objective-c":
      return "objective-c";
    case "protobuf":
      return "proto";
    case "shell":
      return "shellscript";
    default:
      return languageId;
  }
}

function isBundledShikiLanguage(language: string): language is WorkspaceShikiLanguage {
  return (
    language === "text" ||
    Object.prototype.hasOwnProperty.call(workspaceShikiLanguageLookup, language)
  );
}

async function getWorkspaceShikiHighlighter(
  language: WorkspaceShikiLanguage,
): Promise<WorkspaceShikiHighlighter | null> {
  highlighterPromise ??= createWorkspaceShikiHighlighter({
    langs: [],
    themes: [WORKSPACE_SHIKI_THEME_IDS.dark, WORKSPACE_SHIKI_THEME_IDS.light],
    warnings: false,
  });

  const highlighter = await highlighterPromise;
  await loadWorkspaceShikiLanguage(highlighter, language);
  return highlighter;
}

async function loadWorkspaceShikiLanguage(
  highlighter: WorkspaceShikiHighlighter,
  language: WorkspaceShikiLanguage,
): Promise<void> {
  if (language === "text" || loadedLanguages.has(language)) {
    return;
  }

  const existingLoad = loadingLanguages.get(language);
  if (existingLoad) {
    await existingLoad;
    return;
  }

  const load = highlighter
    .loadLanguage(language)
    .then(() => {
      loadedLanguages.add(language);
    })
    .finally(() => {
      loadingLanguages.delete(language);
    });

  loadingLanguages.set(language, load);
  await load;
}

function createWorkspaceShikiDecorations(
  tokenLines: readonly (readonly ThemedToken[])[],
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let pendingDecoration: Decoration | null = null;
  let pendingFrom = 0;
  let pendingTo = 0;

  const flushPending = () => {
    if (pendingDecoration && pendingFrom < pendingTo) {
      builder.add(pendingFrom, pendingTo, pendingDecoration);
    }
    pendingDecoration = null;
  };

  for (const lineTokens of tokenLines) {
    for (const token of lineTokens) {
      const from = token.offset;
      const to = Math.min(docLength, token.offset + token.content.length);
      const decoration =
        from < to && token.content.trim().length > 0 ? getWorkspaceShikiDecoration(token) : null;

      if (!decoration) {
        flushPending();
        continue;
      }

      if (pendingDecoration === decoration && pendingTo === from) {
        pendingTo = to;
        continue;
      }

      flushPending();
      pendingDecoration = decoration;
      pendingFrom = from;
      pendingTo = to;
    }
  }

  flushPending();
  return builder.finish();
}

function getWorkspaceShikiDecoration(token: ThemedToken): Decoration | null {
  const style = createWorkspaceShikiTokenStyle(token);
  if (!style) {
    return null;
  }

  const cached = tokenDecorationCache.get(style);
  if (cached) {
    return cached;
  }

  if (tokenDecorationCache.size >= WORKSPACE_SHIKI_TOKEN_STYLE_CACHE_MAX_SIZE) {
    tokenDecorationCache.clear();
  }

  const decoration = Decoration.mark({
    attributes: { style },
    class: "cm-shiki-token",
  });
  tokenDecorationCache.set(style, decoration);
  return decoration;
}
