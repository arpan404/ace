/**
 * Starter .gitignore files for a new project. Short on purpose: the usual build output,
 * dependencies, local environment files and editor or OS clutter for each stack. The daemon
 * writes the chosen text as is.
 */
export type GitignoreTemplate = "none" | "node" | "python" | "rust" | "go" | "swift";

const shared = [
  "# Local environment",
  ".env",
  ".env.*",
  "!.env.example",
  "",
  "# OS",
  ".DS_Store",
  "Thumbs.db",
  "",
];

const stacks: Record<Exclude<GitignoreTemplate, "none">, { label: string; lines: string[] }> = {
  node: {
    label: "Node",
    lines: [
      "# Dependencies and builds",
      "node_modules/",
      "dist/",
      "build/",
      "coverage/",
      ".turbo/",
      "*.log",
      "",
    ],
  },
  python: {
    label: "Python",
    lines: [
      "# Bytecode, environments and builds",
      "__pycache__/",
      "*.py[cod]",
      ".venv/",
      "venv/",
      "build/",
      "dist/",
      "*.egg-info/",
      ".pytest_cache/",
      ".mypy_cache/",
      "",
    ],
  },
  rust: { label: "Rust", lines: ["# Build output", "target/", ""] },
  go: {
    label: "Go",
    lines: ["# Binaries and test output", "bin/", "*.test", "*.out", "vendor/", ""],
  },
  swift: {
    label: "Swift and Xcode",
    lines: [
      "# Xcode and Swift Package Manager",
      "DerivedData/",
      ".build/",
      "xcuserdata/",
      "*.xcuserstate",
      "",
    ],
  },
};

export const gitignoreOptions: { value: GitignoreTemplate; label: string }[] = [
  { value: "none", label: "No .gitignore" },
  { value: "node", label: stacks.node.label },
  { value: "python", label: stacks.python.label },
  { value: "rust", label: stacks.rust.label },
  { value: "go", label: stacks.go.label },
  { value: "swift", label: stacks.swift.label },
];

/** The file's text, or undefined for none. */
export function gitignoreText(template: GitignoreTemplate): string | undefined {
  if (template === "none") return undefined;
  return [...stacks[template].lines, ...shared].join("\n");
}
