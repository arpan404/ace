import {
  AgentsFileIcon,
  ArchiveFileIcon,
  AssetsFolderIcon,
  AssetsFolderOpenIcon,
  AudioFileIcon,
  CargoFileIcon,
  CFileIcon,
  ChangelogFileIcon,
  CppFileIcon,
  CsharpFileIcon,
  CssFileIcon,
  CsvFileIcon,
  DockerFileIcon,
  DocsFolderIcon,
  DocsFolderOpenIcon,
  EditorconfigFileIcon,
  EnvFileIcon,
  FolderIcon,
  FolderOpenIcon,
  FontFileIcon,
  FormatFileIcon,
  GitFileIcon,
  GithubFolderIcon,
  GithubFolderOpenIcon,
  GoFileIcon,
  GraphqlFileIcon,
  HtmlFileIcon,
  ImageFileIcon,
  JavaFileIcon,
  JavascriptFileIcon,
  JsonFileIcon,
  JsxFileIcon,
  KotlinFileIcon,
  LicenseFileIcon,
  LintFileIcon,
  LockFileIcon,
  LuaFileIcon,
  MakeFileIcon,
  MarkdownFileIcon,
  ModulesFolderIcon,
  ModulesFolderOpenIcon,
  PackageFileIcon,
  PdfFileIcon,
  PhpFileIcon,
  PlainFileIcon,
  PythonFileIcon,
  ReadmeFileIcon,
  RubyFileIcon,
  RustFileIcon,
  ScriptsFolderIcon,
  ScriptsFolderOpenIcon,
  ShellFileIcon,
  SourceFolderIcon,
  SourceFolderOpenIcon,
  SqlFileIcon,
  SvgFileIcon,
  SwiftFileIcon,
  TestFileIcon,
  TestsFolderIcon,
  TestsFolderOpenIcon,
  TextFileIcon,
  TomlFileIcon,
  TsconfigFileIcon,
  TsxFileIcon,
  TypescriptFileIcon,
  VideoFileIcon,
  ViteFileIcon,
  XmlFileIcon,
  YamlFileIcon,
  ZigFileIcon,
} from "@ace/icons";
import {
  fileTypeOf,
  fileTypeTone,
  folderTypeOf,
  folderTypeTone,
  type FileTone,
  type FileType,
  type FolderType,
} from "@ace/ui-core/file-types";
import { createElement } from "react";
import type { IconGlyph } from "@/components/icon.tsx";

/*
 * A file's or folder's icon, the one used wherever a file shows (the explorer, tabs, Open
 * editors, quick open, search, Changes, attachment chips), so a file looks the same everywhere.
 * Which type a name is comes from `@ace/ui-core/file-types`; this module only draws it. A file
 * type is its own outline in its tone, two-tone (tinted body, strokes); a folder keeps the row's
 * ink and only its mark takes the tone. Grey types take the row's ink.
 */

const fileGlyphs: Record<FileType, IconGlyph> = {
  file: PlainFileIcon,
  text: TextFileIcon,
  typescript: TypescriptFileIcon,
  tsx: TsxFileIcon,
  javascript: JavascriptFileIcon,
  jsx: JsxFileIcon,
  json: JsonFileIcon,
  markdown: MarkdownFileIcon,
  rust: RustFileIcon,
  python: PythonFileIcon,
  go: GoFileIcon,
  swift: SwiftFileIcon,
  kotlin: KotlinFileIcon,
  java: JavaFileIcon,
  c: CFileIcon,
  cpp: CppFileIcon,
  csharp: CsharpFileIcon,
  ruby: RubyFileIcon,
  php: PhpFileIcon,
  lua: LuaFileIcon,
  zig: ZigFileIcon,
  shell: ShellFileIcon,
  html: HtmlFileIcon,
  css: CssFileIcon,
  svg: SvgFileIcon,
  yaml: YamlFileIcon,
  toml: TomlFileIcon,
  sql: SqlFileIcon,
  graphql: GraphqlFileIcon,
  xml: XmlFileIcon,
  image: ImageFileIcon,
  video: VideoFileIcon,
  audio: AudioFileIcon,
  pdf: PdfFileIcon,
  archive: ArchiveFileIcon,
  font: FontFileIcon,
  csv: CsvFileIcon,
  env: EnvFileIcon,
  lock: LockFileIcon,
  package: PackageFileIcon,
  tsconfig: TsconfigFileIcon,
  cargo: CargoFileIcon,
  docker: DockerFileIcon,
  make: MakeFileIcon,
  git: GitFileIcon,
  editorconfig: EditorconfigFileIcon,
  readme: ReadmeFileIcon,
  license: LicenseFileIcon,
  changelog: ChangelogFileIcon,
  agents: AgentsFileIcon,
  vite: ViteFileIcon,
  lint: LintFileIcon,
  format: FormatFileIcon,
  test: TestFileIcon,
};

const folderGlyphs: Record<FolderType, { shut: IconGlyph; open: IconGlyph }> = {
  folder: { shut: FolderIcon, open: FolderOpenIcon },
  src: { shut: SourceFolderIcon, open: SourceFolderOpenIcon },
  tests: { shut: TestsFolderIcon, open: TestsFolderOpenIcon },
  docs: { shut: DocsFolderIcon, open: DocsFolderOpenIcon },
  github: { shut: GithubFolderIcon, open: GithubFolderOpenIcon },
  modules: { shut: ModulesFolderIcon, open: ModulesFolderOpenIcon },
  scripts: { shut: ScriptsFolderIcon, open: ScriptsFolderOpenIcon },
  assets: { shut: AssetsFolderIcon, open: AssetsFolderOpenIcon },
};

const ink = (tone: FileTone): string | undefined =>
  tone === "grey" ? undefined : `var(--file-${tone})`;

/** A file type's icon: two-tone in its tone, whatever weight the row asks for. */
function drawnFile(Glyph: IconGlyph, tone: FileTone): IconGlyph {
  const color = ink(tone);
  const File: IconGlyph = (props) =>
    createElement(Glyph, { ...props, weight: "duotone", ...(color ? { color } : {}) });
  File.displayName = Glyph.displayName ?? "File";
  return File;
}

/** A folder's icon: outline in the row's ink, its mark in its tone; installed modules dimmed. */
function drawnFolder(Glyph: IconGlyph, type: FolderType): IconGlyph {
  const accent = ink(folderTypeTone(type));
  const dimmed = type === "modules";
  const Folder: IconGlyph = (props) =>
    createElement(Glyph, {
      ...props,
      weight: "regular",
      ...(accent ? { accent } : {}),
      ...(dimmed ? { style: { ...props.style, opacity: 0.55 } } : {}),
    });
  Folder.displayName = Glyph.displayName ?? "Folder";
  return Folder;
}

// Each type's drawn icon is made once, so a row keeps the same component from render to render.
const files = new Map<FileType, IconGlyph>();
const folders = new Map<string, IconGlyph>();

/** The icon of a file type. */
export function fileTypeIcon(type: FileType): IconGlyph {
  let drawn = files.get(type);
  if (!drawn) {
    drawn = drawnFile(fileGlyphs[type], fileTypeTone(type));
    files.set(type, drawn);
  }
  return drawn;
}

/** A file's icon, from its name (special names first, then its extension). */
export function fileIcon(path: string): IconGlyph {
  return fileTypeIcon(fileTypeOf(path));
}

/** A file's icon when its name says what it is; undefined for a file of no known type. */
export function knownFileIcon(path: string): IconGlyph | undefined {
  const type = fileTypeOf(path);
  return type === "file" ? undefined : fileTypeIcon(type);
}

/** A folder's icon, closed or open, from its own name. */
export function folderIcon(path: string, open = false): IconGlyph {
  const type = folderTypeOf(path);
  const key = `${type}:${open ? "open" : "shut"}`;
  let drawn = folders.get(key);
  if (!drawn) {
    const glyphs = folderGlyphs[type];
    drawn = drawnFolder(open ? glyphs.open : glyphs.shut, type);
    folders.set(key, drawn);
  }
  return drawn;
}
