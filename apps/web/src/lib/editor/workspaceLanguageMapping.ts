export const MONACO_DOTENV_LANGUAGE_ID = "dotenv";
export const MONACO_PRISMA_LANGUAGE_ID = "prisma";

const BASENAME_LANGUAGE_MAP = new Map<string, string>([
  [".editorconfig", "ini"],
  ["cmakelists.txt", "cpp"],
  ["dockerfile", "dockerfile"],
  ["gemfile", "ruby"],
  ["makefile", "shell"],
  ["podfile", "ruby"],
  ["rakefile", "ruby"],
  ["vagrantfile", "ruby"],
]);

const SHELL_BASENAMES = new Set([
  ".bash_profile",
  ".bashrc",
  ".envrc",
  ".profile",
  ".zprofile",
  ".zshenv",
  ".zshrc",
]);

type LanguageSuffixGroup = readonly [string, readonly string[]];

const LANGUAGE_SUFFIX_GROUPS: ReadonlyArray<LanguageSuffixGroup> = [
  ["typescript", [".ts", ".tsx", ".mts", ".cts"]],
  ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["json", [".json", ".jsonc"]],
  ["css", [".css"]],
  ["scss", [".scss"]],
  ["less", [".less"]],
  ["html", [".html", ".htm"]],
  ["markdown", [".md"]],
  ["mdx", [".mdx"]],
  ["yaml", [".yml", ".yaml"]],
  ["graphql", [".graphql", ".gql"]],
  ["shell", [".sh", ".bash", ".zsh"]],
  ["sql", [".sql"]],
  ["xml", [".xml", ".svg", ".plist", ".xsd", ".xsl", ".xslt"]],
  ["ini", [".ini", ".cfg", ".conf", ".properties", ".toml"]],
  ["protobuf", [".proto"]],
  ["powershell", [".ps1", ".psm1", ".psd1"]],
  ["hcl", [".tf", ".tfvars", ".hcl"]],
  ["rust", [".rs"]],
  ["go", [".go"]],
  ["python", [".py"]],
  ["ruby", [".rb", ".rake", ".gemspec"]],
  ["php", [".php"]],
  ["java", [".java"]],
  ["kotlin", [".kt", ".kts"]],
  ["swift", [".swift"]],
  ["cpp", [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]],
  ["csharp", [".cs", ".csx"]],
  ["dart", [".dart"]],
  ["lua", [".lua"]],
  ["scala", [".scala", ".sc"]],
  ["perl", [".pl", ".pm"]],
  ["objective-c", [".m", ".mm"]],
  ["bat", [".bat", ".cmd"]],
  ["solidity", [".sol"]],
  [MONACO_PRISMA_LANGUAGE_ID, [".prisma"]],
];

function resolveLanguageBySuffix(normalizedPath: string): string | undefined {
  for (const [language, suffixes] of LANGUAGE_SUFFIX_GROUPS) {
    if (suffixes.some((suffix) => normalizedPath.endsWith(suffix))) {
      return language;
    }
  }
  return undefined;
}

export function resolveMonacoLanguageFromFilePath(filePath: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const normalizedPath = filePath.toLowerCase();
  const basename = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;

  if (basename.startsWith(".env")) {
    return MONACO_DOTENV_LANGUAGE_ID;
  }
  if (basename === "dockerfile" || basename.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  const explicitLanguage = BASENAME_LANGUAGE_MAP.get(basename);
  if (explicitLanguage) {
    return explicitLanguage;
  }
  if (SHELL_BASENAMES.has(basename)) {
    return "shell";
  }
  return resolveLanguageBySuffix(normalizedPath);
}
