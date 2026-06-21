function normalizeCliOutput(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.trim();
}

function findJsonValueEnd(raw: string, startIndex: number): number | null {
  const start = raw[startIndex];
  if (start !== "[" && start !== "{") {
    return null;
  }

  const stack: string[] = [start === "[" ? "]" : "}"];
  let inString = false;
  let escaping = false;

  for (let index = startIndex + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === undefined) {
      return null;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[" || char === "{") {
      stack.push(char === "[" ? "]" : "}");
      continue;
    }

    if (char === "]" || char === "}") {
      const expected = stack.pop();
      if (expected !== char) {
        return null;
      }
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

export function parseJsonFromCliOutput(raw: string): unknown {
  const normalized = normalizeCliOutput(raw);
  if (normalized.length === 0) {
    throw new Error("CLI output was empty.");
  }

  const candidates = parseJsonFromCliOutputCandidates(raw);
  if (candidates.length === 0) {
    throw new Error("Unable to locate a valid JSON payload in CLI output.");
  }

  return candidates[0];
}

export function parseJsonFromCliOutputCandidates(raw: string): unknown[] {
  const normalized = normalizeCliOutput(raw);
  if (normalized.length === 0) {
    return [];
  }

  const parsed: unknown[] = [];
  try {
    parsed.push(JSON.parse(normalized) as unknown);
    return parsed;
  } catch {
    // Fall through to tolerant extraction for CLIs that emit extra text around JSON.
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== "[" && char !== "{") {
      continue;
    }

    const endIndex = findJsonValueEnd(normalized, index);
    if (endIndex === null) {
      continue;
    }

    const candidate = normalized.slice(index, endIndex);
    try {
      parsed.push(JSON.parse(candidate) as unknown);
    } catch {
      continue;
    }
  }

  return parsed;
}
