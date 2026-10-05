/** Pure naming fallback. Explicit provider names take precedence over id parsing. */
export function modelDisplayName(
  id: string,
  suppliedName?: string,
): {
  displayName: string;
  upstreamProvider?: string;
} {
  const slash = id.indexOf("/");
  const upstreamProvider = slash < 0 ? undefined : id.slice(0, slash);
  const native = slash < 0 ? id : id.slice(slash + 1);
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
  const clean = native.replace(/\b(\d)-(\d)(?=-|$)/g, "$1.$2");
  const tokens = clean.split(/[-_ ]+/).filter(Boolean);
  const name = tokens
    .map(
      (token) =>
        brands[token.toLowerCase()] ??
        (/^(?:\d.*[bB]|[aAvVkK]\d)/.test(token)
          ? token.toUpperCase()
          : token.charAt(0).toUpperCase() + token.slice(1)),
    )
    .join(" ");
  const displayName = suppliedName?.trim() || name.replace(/^GPT (\d)/, "GPT-$1");
  return { displayName, ...(upstreamProvider ? { upstreamProvider } : {}) };
}
