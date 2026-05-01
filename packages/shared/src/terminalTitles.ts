const TERMINAL_COMMAND_CONNECTOR = /\s*(?:&&|\|\||[|;])\s*/;
const GENERIC_TERMINAL_TITLES = new Set([
  "ace",
  "bash",
  "cmd",
  "cmd.exe",
  "fish",
  "oa",
  "powershell",
  "pwsh",
  "sh",
  "shell",
  "terminal",
  "zsh",
]);
const WRAPPER_BINARIES = new Set(["ace", "oa"]);
const SHELL_BINARIES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const KNOWN_COMMAND_TITLE_BINARIES = new Set([
  "astro",
  "awk",
  "cat",
  "chmod",
  "chown",
  "claude",
  "clear",
  "code",
  "codex",
  "cp",
  "curl",
  "emacs",
  "eslint",
  "fd",
  "find",
  "gh",
  "grep",
  "head",
  "htop",
  "jest",
  "kill",
  "less",
  "ls",
  "mkdir",
  "mv",
  "nano",
  "nvim",
  "open",
  "oxfmt",
  "oxlint",
  "playwright",
  "prettier",
  "ps",
  "rg",
  "rm",
  "rsync",
  "scp",
  "sed",
  "sleep",
  "ssh",
  "tail",
  "top",
  "touch",
  "tree",
  "tsc",
  "tsup",
  "tsx",
  "turbo",
  "vercel",
  "vim",
  "vite",
  "vitest",
  "watch",
  "wget",
  "wrangler",
  "xcodebuild",
]);
const TERMINAL_INPUT_RESIDUE_REGEX = /(?:\[[0-9;?]*[~A-Za-z]|(?:^|[:\s])O[A-D](?:[0-9A-D]*)?)/;

function basename(pathValue: string): string {
  const normalized = pathValue.trim().replace(/[\\/]+$/, "");
  if (normalized.length === 0) return "";
  const segments = normalized.split(/[\\/]+/);
  return segments[segments.length - 1] ?? "";
}

function normalizeTerminalTitle(title: string): string | null {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, 80);
}

function isGenericTerminalTitle(title: string): boolean {
  return GENERIC_TERMINAL_TITLES.has(title.trim().toLowerCase());
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return matches?.map((token) => stripQuotes(token)) ?? [];
}

function hasTerminalControlCode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b) {
      return true;
    }
  }
  return false;
}

function hasTerminalInputResidue(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    (hasTerminalControlCode(value) || TERMINAL_INPUT_RESIDUE_REGEX.test(value))
  );
}

function titleFromPackageManagerCommand(
  binary: string,
  arg1: string | undefined,
  arg2: string | undefined,
) {
  if (arg1 && ["run", "x", "exec"].includes(arg1) && arg2) {
    return hasTerminalInputResidue(arg2) ? null : `${binary} ${arg2}`;
  }
  if (arg1) {
    return hasTerminalInputResidue(arg1) ? null : `${binary} ${arg1}`;
  }
  return binary;
}

export function deriveTerminalTitleFromCommand(command: string): string | null {
  const normalized = command.trim();
  if (normalized.length === 0) return null;
  if (hasTerminalInputResidue(normalized)) return null;

  const primarySegment = normalized.split(TERMINAL_COMMAND_CONNECTOR)[0]?.trim() ?? "";
  if (primarySegment.length === 0) return null;

  const commandWithoutEnv = primarySegment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/,
    "",
  );
  const commandWithoutPrefix = commandWithoutEnv.replace(/^(?:sudo|env|command)\s+/, "");
  const tokens = tokenizeCommand(commandWithoutPrefix);
  if (tokens.length === 0) return null;

  const rawBinary = tokens[0] ?? "";
  const binary = basename(rawBinary).toLowerCase();
  const arg1 = tokens[1]?.trim();
  const arg2 = tokens[2]?.trim();

  if (WRAPPER_BINARIES.has(binary)) {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]?.trim();
      if (!token) {
        continue;
      }
      if (token.startsWith("-")) {
        const maybeValue = tokens[index + 1]?.trim();
        if (maybeValue && !maybeValue.startsWith("-")) {
          index += 1;
        }
        continue;
      }
      return deriveTerminalTitleFromCommand(tokens.slice(index).join(" "));
    }
    return null;
  }

  if (SHELL_BINARIES.has(binary) && ["-c", "-lc"].includes(arg1 ?? "") && arg2) {
    return deriveTerminalTitleFromCommand(arg2);
  }

  if (["bun", "npm", "pnpm", "yarn"].includes(binary)) {
    return titleFromPackageManagerCommand(binary, arg1, arg2);
  }

  if (binary === "git") {
    return arg1 ? `git ${arg1}` : "git";
  }

  if (binary === "docker" && arg1 === "compose") {
    return arg2 ? `docker compose ${arg2}` : "docker compose";
  }

  if (["python", "python3", "node", "deno"].includes(binary)) {
    if (arg1 && !arg1.startsWith("-")) {
      return `${binary} ${basename(arg1)}`;
    }
    return binary;
  }

  if (["cargo", "go", "make", "just"].includes(binary) && arg1) {
    return `${binary} ${arg1}`;
  }

  if (isGenericTerminalTitle(binary)) {
    return null;
  }

  if (KNOWN_COMMAND_TITLE_BINARIES.has(binary)) {
    return binary;
  }

  if (/[\\/]/.test(rawBinary) && binary.length > 0) {
    return binary;
  }

  return null;
}

function skipTerminalEscapeSequence(data: string, escapeIndex: number): number {
  const next = data[escapeIndex + 1];
  if (!next) return escapeIndex;

  if (next === "[") {
    for (let index = escapeIndex + 2; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index;
      }
    }
    return data.length - 1;
  }

  if (next === "O") {
    return Math.min(escapeIndex + 2, data.length - 1);
  }

  if (next === "]") {
    for (let index = escapeIndex + 2; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (code === 0x07) {
        return index;
      }
      if (code === 0x1b && data[index + 1] === "\\") {
        return index + 1;
      }
    }
    return data.length - 1;
  }

  return escapeIndex + 1;
}

export function extractTerminalOscTitle(data: string): string | null {
  const oscStart = data.lastIndexOf("\u001b]");
  if (oscStart < 0) return null;
  const payload = data.slice(oscStart + 2);
  if (!(payload.startsWith("0;") || payload.startsWith("2;"))) {
    return null;
  }
  const titlePayload = payload.slice(2);
  const bellIndex = titlePayload.indexOf("\u0007");
  const stIndex = titlePayload.indexOf("\u001b\\");
  const endIndexCandidates = [bellIndex, stIndex].filter((index) => index >= 0);
  const endIndex = endIndexCandidates.length > 0 ? Math.min(...endIndexCandidates) : -1;
  if (endIndex < 0) return null;
  const normalized = normalizeTerminalTitle(titlePayload.slice(0, endIndex));
  if (!normalized || isGenericTerminalTitle(normalized)) {
    return null;
  }
  return normalized;
}

export function applyTerminalInputToBuffer(
  buffer: string,
  data: string,
): {
  buffer: string;
  submittedCommand: string | null;
} {
  let nextBuffer = buffer;
  let submittedCommand: string | null = null;

  for (let index = 0; index < data.length; index += 1) {
    const chunk = data[index];
    if (!chunk) continue;

    if (chunk === "\u001b") {
      index = skipTerminalEscapeSequence(data, index);
      continue;
    }
    if (chunk === "\r" || chunk === "\n") {
      submittedCommand = nextBuffer.trim().length > 0 ? nextBuffer.trim() : null;
      nextBuffer = "";
      continue;
    }
    if (chunk === "\u007f") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }
    if (chunk === "\u0015" || chunk === "\u0003") {
      nextBuffer = "";
      continue;
    }
    if (chunk < " ") {
      continue;
    }
    nextBuffer += chunk;
  }

  return { buffer: nextBuffer, submittedCommand };
}
