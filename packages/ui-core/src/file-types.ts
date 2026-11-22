/*
 * What kind of file or folder a name is, for its icon: one rule for every place a file shows
 * (the explorer, tabs, quick open, search, changes, attachment chips), so a file looks the same
 * everywhere. Pure: a name in, a type and its tone out. Whole special names win over
 * extensions, then compound endings ("foo.test.ts", ".env.local"), then the last extension;
 * case never matters. Anything unknown is a plain file.
 */

/**
 * The palette a type's mark is drawn in: brand-ish hues, never a status colour's meaning. `grey`
 * is the row's own ink.
 */
export type FileTone =
  | "blue"
  | "sky"
  | "teal"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "pink"
  | "purple"
  | "grey";

export const fileTones: readonly FileTone[] = [
  "blue",
  "sky",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "grey",
];

/** Every file type, with the tone its mark is drawn in. */
const types = {
  file: "grey",
  text: "grey",
  typescript: "blue",
  tsx: "blue",
  javascript: "yellow",
  jsx: "yellow",
  json: "yellow",
  markdown: "sky",
  rust: "orange",
  python: "blue",
  go: "sky",
  swift: "orange",
  kotlin: "purple",
  java: "red",
  c: "blue",
  cpp: "purple",
  csharp: "green",
  ruby: "red",
  php: "purple",
  lua: "blue",
  zig: "orange",
  shell: "green",
  html: "orange",
  css: "blue",
  svg: "yellow",
  yaml: "red",
  toml: "grey",
  sql: "sky",
  graphql: "pink",
  xml: "teal",
  image: "teal",
  video: "pink",
  audio: "purple",
  pdf: "red",
  archive: "yellow",
  font: "pink",
  csv: "green",
  env: "yellow",
  lock: "grey",
  package: "green",
  tsconfig: "blue",
  cargo: "orange",
  docker: "sky",
  make: "orange",
  git: "orange",
  editorconfig: "grey",
  readme: "sky",
  license: "yellow",
  changelog: "teal",
  agents: "purple",
  vite: "purple",
  lint: "teal",
  format: "teal",
  test: "green",
} as const satisfies Record<string, FileTone>;

export type FileType = keyof typeof types;

/** The tone a file type's mark is drawn in. */
export const fileTypeTone = (type: FileType): FileTone => types[type];

/** Whole names, lowercased, that say more than their extension. */
const byName: Record<string, FileType> = {
  "package.json": "package",
  "cargo.toml": "cargo",
  "cargo.lock": "lock",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "package-lock.json": "lock",
  "yarn.lock": "lock",
  "pnpm-lock.yaml": "lock",
  "deno.lock": "lock",
  "gemfile.lock": "lock",
  "poetry.lock": "lock",
  "uv.lock": "lock",
  "go.sum": "lock",
  dockerfile: "docker",
  containerfile: "docker",
  ".dockerignore": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "compose.yml": "docker",
  "compose.yaml": "docker",
  makefile: "make",
  gnumakefile: "make",
  justfile: "make",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".editorconfig": "editorconfig",
  readme: "readme",
  license: "license",
  licence: "license",
  notice: "license",
  copying: "license",
  changelog: "changelog",
  "agents.md": "agents",
  "claude.md": "agents",
  "gemini.md": "agents",
  ".oxlintrc": "lint",
  ".oxlintrc.json": "lint",
  ".oxfmtrc": "format",
  ".oxfmtrc.json": "format",
  ".prettierrc": "format",
  "go.mod": "go",
  gemfile: "ruby",
  rakefile: "ruby",
};

/** Documents known by their stem when written as prose ("README.md", "LICENSE.txt"). */
const byStem: Record<string, FileType> = {
  readme: "readme",
  license: "license",
  licence: "license",
  notice: "license",
  changelog: "changelog",
};
const proseExtension = /^(md|markdown|mdx|txt|rst|adoc|org)$/;

/** Endings longer than one extension, tested before the last one. */
const byEnding: readonly (readonly [RegExp, FileType])[] = [
  [/\.(test|spec|bench)\.[cm]?[jt]sx?$/, "test"],
  [/_test\.(go|py)$/, "test"],
  [/^test_.+\.py$/, "test"],
  [/^tsconfig(\..+)?\.json$/, "tsconfig"],
  [/^jsconfig(\..+)?\.json$/, "tsconfig"],
  [/^vite(st)?\.(config|workspace)(\..+)?\.[cm]?[jt]s$/, "vite"],
  [/^\.env(\..+)?$/, "env"],
  [/^(docker|container)file\..+$/, "docker"],
  [/\.d\.[cm]?ts$/, "typescript"],
];

const byExtension: Record<string, FileType> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  m: "c",
  mm: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  svg: "svg",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "toml",
  conf: "toml",
  cfg: "toml",
  sql: "sql",
  sqlite: "sql",
  db: "sql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
  plist: "xml",
  xsd: "xml",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  heic: "image",
  bmp: "image",
  ico: "image",
  icns: "image",
  tiff: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  avi: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  flac: "audio",
  ogg: "audio",
  aac: "audio",
  opus: "audio",
  pdf: "pdf",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  "7z": "archive",
  rar: "archive",
  xz: "archive",
  bz2: "archive",
  zst: "archive",
  dmg: "archive",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  eot: "font",
  csv: "csv",
  tsv: "csv",
  txt: "text",
  log: "text",
  rst: "text",
  env: "env",
  lock: "lock",
  lockb: "lock",
};

/** The last segment of a path, `/` or `\` separated. */
const baseName = (path: string): string => {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
};

/** The type of the file at `path` (a name or a whole path). */
export function fileTypeOf(path: string): FileType {
  const name = baseName(path).toLowerCase();
  const named = byName[name];
  if (named) return named;
  for (const [ending, type] of byEnding) if (ending.test(name)) return type;
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  const stem = dot > 0 && proseExtension.test(extension) ? byStem[name.slice(0, dot)] : undefined;
  return stem ?? byExtension[extension] ?? "file";
}

/** Folders that get a mark of their own; any other folder is plain. */
const folders = {
  folder: "grey",
  src: "blue",
  tests: "green",
  docs: "sky",
  github: "purple",
  modules: "grey",
  scripts: "green",
  assets: "teal",
} as const satisfies Record<string, FileTone>;

export type FolderType = keyof typeof folders;

/** The tone a folder type's mark is drawn in. */
export const folderTypeTone = (type: FolderType): FileTone => folders[type];

const folderNames: Record<string, FolderType> = {
  src: "src",
  source: "src",
  lib: "src",
  test: "tests",
  tests: "tests",
  __tests__: "tests",
  spec: "tests",
  e2e: "tests",
  doc: "docs",
  docs: "docs",
  ".github": "github",
  node_modules: "modules",
  scripts: "scripts",
  bin: "scripts",
  assets: "assets",
  public: "assets",
  static: "assets",
  images: "assets",
  media: "assets",
};

/** The type of the folder at `path`, from its own name. */
export function folderTypeOf(path: string): FolderType {
  const name = baseName(path.replace(/[/\\]+$/, "")).toLowerCase();
  return folderNames[name] ?? "folder";
}
