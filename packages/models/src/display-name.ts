/** Internal free-preview tags are pricing metadata, never a visible snapshot label. */
export function modelDetail(detail: string | undefined): string | undefined {
  return (
    detail
      ?.split(" · ")
      .filter((part) => !/^preview[-_]free$/i.test(part))
      .join(" · ") || undefined
  );
}

/** Snapshot identifiers describe an execution route, never the model's version. */
export function modelIdentity(id: string): {
  name: string;
  detail?: string;
  family?: string;
  version?: string;
} {
  const native = id.slice(id.lastIndexOf("/") + 1);
  const snapshots: string[] = [];
  let name = native;
  for (let i = 0; i < 4; i++) {
    const suffix =
      /[-_](20\d{6}|20\d{2}-\d{2}-\d{2}|latest|preview(?:[-_][a-z0-9]+)+|[a-f0-9]{8,})$/i.exec(
        name,
      );
    if (!suffix?.[1]) break;
    snapshots.unshift(suffix[1]);
    name = name.slice(0, suffix.index);
  }
  name = name.replace(/^(glm)-(\d+)p(\d+)(?=-|$)/i, "$1-$2.$3");
  const detail = modelDetail(snapshots.join(" · "));
  const oldClaude = /^claude-(\d+(?:[.-]\d+)?)-(opus|sonnet|haiku|fable)$/i.exec(name);
  const claude =
    /^(?:claude-)?(opus|sonnet|haiku|fable)(?:[- ](\d+(?:[.-]\d+)?))?$/i.exec(name) ??
    (oldClaude ? [oldClaude[0], oldClaude[2], oldClaude[1]] : undefined);
  if (claude?.[1]) {
    const family = `claude-${claude[1].toLowerCase()}`;
    const version = claude[2]?.replaceAll("-", ".");
    return {
      name: `${claude[1][0]?.toUpperCase()}${claude[1].slice(1)}${version ? ` ${version}` : ""}`,
      family,
      ...(version ? { version } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  const gpt = /^gpt-(\d+(?:[.-]\d+)?)(?:-(.+))?$/i.exec(name);
  if (gpt?.[1]) {
    const version = gpt[1].replaceAll("-", ".");
    const tier = gpt[2]?.toLowerCase();
    return { name, family: `gpt${tier ? `-${tier}` : ""}`, version, ...(detail ? { detail } : {}) };
  }
  // Only recognized families get versions; numeric custom selectors stay opaque.
  // Qualifiers after the version distinguish variants, including a plain "preview".
  const general =
    /^(muse[-_ ]spark|composer|gemini|grok|llama|qwen|glm|mistral|codestral|kimi|deepseek|o)[-_ ]?(\d+(?:[.-]\d+)?)(.*)$/i.exec(
      name,
    );
  return {
    name,
    ...(detail ? { detail } : {}),
    ...(general?.[1] && general[2]
      ? {
          family: `${general[1]}${general[3] ?? ""}`.toLowerCase().replace(/[-_ ]+/g, "-"),
          version: general[2].replaceAll("-", "."),
        }
      : {}),
  };
}

/** Good native names survive; raw IDs and snapshot-bearing names use the family formatter. */
export function modelDisplayName(
  id: string,
  suppliedName?: string,
): {
  displayName: string;
  upstreamProvider?: string;
  detail?: string;
  family?: string;
  version?: string;
} {
  const slash = id.indexOf("/");
  const upstreamProvider = slash < 0 ? undefined : id.slice(0, slash);
  const identity = modelIdentity(id);
  const brands: Record<string, string> = {
    gpt: "GPT",
    claude: "Claude",
    llama: "Llama",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    glm: "GLM",
    grok: "Grok",
    gemini: "Gemini",
    mistral: "Mistral",
    codestral: "Codestral",
    kimi: "Kimi",
    mini: "Mini",
    nano: "Nano",
    api: "API",
    o1: "o1",
    o3: "o3",
    o4: "o4",
    oss: "OSS",
    vl: "VL",
    it: "IT",
  };
  const clean = identity.name.replace(/\b(\d)-(\d)(?=-|$)/g, "$1.$2");
  const derived = clean
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map(
      (token) =>
        brands[token.toLowerCase()] ??
        (/^(?:\d.*[bB]|[aAvVkK]\d)/.test(token)
          ? token.toUpperCase()
          : token.charAt(0).toUpperCase() + token.slice(1)),
    )
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
  const supplied = suppliedName?.trim();
  const raw =
    supplied?.toLowerCase() === id.toLowerCase() ||
    supplied?.toLowerCase() === id.slice(slash + 1).toLowerCase();
  const snapshot =
    supplied &&
    /(?:20\d{6}|20\d{2}-\d{2}-\d{2}|\blatest\b|\bpreview\b|\b[a-f0-9]{8,}\b)/i.test(supplied);
  const namedVersion = supplied
    ? /(?:Opus|Sonnet|Haiku|Fable)\s+(\d+(?:\.\d+)?)/i.exec(supplied)?.[1]
    : undefined;
  const wrongVersion =
    identity.family?.startsWith("claude-") && namedVersion && namedVersion !== identity.version;
  const lowercase = supplied && supplied === supplied.toLowerCase();
  const displayName =
    supplied && !raw && !snapshot && !wrongVersion && !lowercase ? supplied : derived;
  return {
    displayName,
    ...(upstreamProvider ? { upstreamProvider } : {}),
    ...(identity.detail ? { detail: identity.detail } : {}),
    ...(identity.family ? { family: identity.family } : {}),
    ...(identity.version ? { version: identity.version } : {}),
  };
}
