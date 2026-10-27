/*
 * TeX as readable Unicode text, for native clients that draw prose with the platform's own text
 * engine (the phone apps), where the web typesets math with KaTeX. Greek letters and operators
 * become their symbols, simple super- and subscripts their raised and lowered characters,
 * fractions a slash, roots √. Whatever it doesn't know stays as written, so nothing is lost.
 * Pure.
 */

const symbols: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  propto: "∝",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  iff: "⇔",
  implies: "⇒",
  mapsto: "↦",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  circ: "∘",
  degree: "°",
  prime: "′",
  hbar: "ℏ",
  ell: "ℓ",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  vert: "|",
  mid: "∣",
  parallel: "∥",
  perp: "⊥",
  angle: "∠",
  star: "⋆",
  ast: "∗",
  log: "log",
  ln: "ln",
  exp: "exp",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  max: "max",
  min: "min",
  lim: "lim",
  det: "det",
  gcd: "gcd",
  quad: "  ",
  qquad: "    ",
  ",": " ",
  ";": " ",
  ":": " ",
  "!": "",
  " ": " ",
  "{": "{",
  "}": "}",
  "%": "%",
  $: "$",
  "&": "&",
  "#": "#",
  _: "_",
  left: "",
  right: "",
  big: "",
  Big: "",
  displaystyle: "",
  limits: "",
};

const blackboard: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ" };

const superscripts: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  T: "ᵀ",
  "′": "′",
};
const subscripts: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  n: "ₙ",
  m: "ₘ",
  o: "ₒ",
  r: "ᵣ",
  t: "ₜ",
  x: "ₓ",
};

/** Reads one argument at `at`: a braced group or a single character (or command). */
function argument(tex: string, at: number): { text: string; end: number } {
  let index = at;
  while (tex[index] === " ") index++;
  if (tex[index] === "{") {
    let depth = 1;
    let end = index + 1;
    while (end < tex.length && depth) {
      if (tex[end] === "\\") end++;
      else if (tex[end] === "{") depth++;
      else if (tex[end] === "}") depth--;
      end++;
    }
    return { text: tex.slice(index + 1, end - 1), end };
  }
  if (tex[index] === "\\") {
    const name = /^\\([A-Za-z]+|.)/.exec(tex.slice(index));
    const length = name?.[0].length ?? 1;
    return { text: tex.slice(index, index + length), end: index + length };
  }
  return { text: tex[index] ?? "", end: index + 1 };
}

/** Raised or lowered characters when every one has a form, else `^(…)` / `_(…)`. */
function script(text: string, table: Record<string, string>, mark: string): string {
  const chars = [...text];
  if (chars.length && chars.every((char) => table[char] !== undefined))
    return chars.map((char) => table[char]).join("");
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

/** A group's text, bracketed when it is more than one term. */
const grouped = (text: string) => (/^[\p{L}\p{N}.′]+$/u.test(text) ? text : `(${text})`);

/** TeX (without its `$` delimiters) as Unicode text. */
export function texText(tex: string): string {
  let out = "";
  let at = 0;
  while (at < tex.length) {
    const char = tex[at] ?? "";
    if (char === "\\") {
      const match = /^\\([A-Za-z]+|.)/.exec(tex.slice(at));
      const name = match?.[1] ?? "";
      at += match?.[0].length ?? 1;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const top = argument(tex, at);
        const bottom = argument(tex, top.end);
        at = bottom.end;
        out += `${grouped(texText(top.text))}/${grouped(texText(bottom.text))}`;
      } else if (name === "sqrt") {
        const body = argument(tex, at);
        at = body.end;
        out += `√${grouped(texText(body.text))}`;
      } else if (
        [
          "text",
          "mathrm",
          "textrm",
          "operatorname",
          "mathit",
          "mathbf",
          "boldsymbol",
          "mathsf",
          "mathtt",
        ].includes(name)
      ) {
        const body = argument(tex, at);
        at = body.end;
        out += name.startsWith("text") || name === "operatorname" ? body.text : texText(body.text);
      } else if (name === "mathbb") {
        const body = argument(tex, at);
        at = body.end;
        out += [...body.text].map((letter) => blackboard[letter] ?? letter).join("");
      } else if (["hat", "bar", "vec", "tilde", "dot", "overline"].includes(name)) {
        const body = argument(tex, at);
        at = body.end;
        const accent = { hat: "̂", bar: "̄", vec: "⃗", tilde: "̃", dot: "̇", overline: "̅" }[name];
        const inner = texText(body.text);
        out += [...inner].length === 1 ? `${inner}${accent}` : inner;
      } else if (symbols[name] !== undefined) {
        out += symbols[name];
      } else {
        out += `\\${name}`;
      }
      continue;
    }
    if (char === "^" || char === "_") {
      const body = argument(tex, at + 1);
      at = body.end;
      out += script(texText(body.text), char === "^" ? superscripts : subscripts, char);
      continue;
    }
    if (char === "{" || char === "}") {
      at++;
      continue;
    }
    out += char === "~" ? " " : char;
    at++;
  }
  return out.replace(/ {3,}/g, "  ");
}

/** A paragraph's math, found outside code spans: `$…$`, `\(…\)`, `$$…$$` and `\[…\]`. */
const inlineMath =
  /(`+)[\s\S]*?\1|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g;

/**
 * An agent's Markdown with its math as text: display math (`$$` or `\[` on lines of their own)
 * as a fenced ```math block, inline math in place. Code spans and fences are left as written.
 */
export function proseMath(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  let fence: string | undefined;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    const opens = trimmed === "$$" ? "$$" : trimmed === "\\[" ? "\\]" : undefined;
    if (opens) {
      const closer = opens === "$$" ? "$$" : "\\]";
      const end = lines.findIndex((candidate, index) => index > at && candidate.trim() === closer);
      if (end > at) {
        out.push("```math", texText(lines.slice(at + 1, end).join(" ")).trim(), "```");
        at = end;
        continue;
      }
    }
    out.push(
      line.replace(
        inlineMath,
        (whole: string, ticks?: string, ...groups: (string | undefined)[]) => {
          if (ticks) return whole;
          const tex = groups.slice(0, 4).find((group) => group !== undefined);
          return tex === undefined ? whole : texText(tex);
        },
      ),
    );
  }
  return out.join("\n");
}
