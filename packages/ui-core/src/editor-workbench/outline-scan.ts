/*
 * Single-pass line scanner for brace-delimited languages (TS/JS, Rust, Go/C-like).
 * Strips comments and string literals while tracking brace depth so symbol declarations inside
 * comments or strings are never matched and symbol end lines match closing braces.
 */

export interface ScannedLine {
  /** Line content with strings and comments replaced by spaces, preserving column offsets. */
  code: string;
  /** Brace depth before this line starts. */
  startDepth: number;
  /** Brace depth after this line finishes. */
  endDepth: number;
  /** Whether an opening `{` appeared on this line. */
  openedBrace: boolean;
  /** Minimum brace depth reached after the first `{` on this line (or endDepth if none). */
  minDepthAfterOpen: number;
}

export interface ScanStyle {
  /** Allow backtick template literals (`...`) spanning multiple lines (TS/JS/Go). */
  backtickStrings: boolean;
  /** Allow single-quoted multi-character strings (TS/JS); false for Rust char lifetimes `'a`. */
  singleQuotedStrings: boolean;
  /** Allow nested block comments (Rust). */
  nestedBlockComments: boolean;
  /** Allow Rust raw strings `r#"..."#`. */
  rustRawStrings: boolean;
}

export const tsScanStyle: ScanStyle = {
  backtickStrings: true,
  singleQuotedStrings: true,
  nestedBlockComments: false,
  rustRawStrings: false,
};

export const rustScanStyle: ScanStyle = {
  backtickStrings: false,
  singleQuotedStrings: false,
  nestedBlockComments: true,
  rustRawStrings: true,
};

export const goScanStyle: ScanStyle = {
  backtickStrings: true,
  singleQuotedStrings: false,
  nestedBlockComments: false,
  rustRawStrings: false,
};

/**
 * Scans `lines` once, stripping comments and string contents in place (replaced with spaces to
 * preserve 1-based column positions) and recording brace depths per line.
 */
export function scanBraceLines(lines: readonly string[], style: ScanStyle): ScannedLine[] {
  const out: ScannedLine[] = [];
  let blockCommentDepth = 0;
  let inBacktick = false;
  let rawHashes = -1; // >= 0 while inside Rust r#*"..."#*
  let depth = 0;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li] ?? "";
    const startDepth = depth;
    let openedBrace = false;
    let minDepthAfterOpen = depth;
    let inDouble = false;
    let inSingle = false;
    let chars: string[] | undefined;

    const blank = (index: number) => {
      if (!chars) chars = raw.split("");
      chars[index] = " ";
    };

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];

      if (blockCommentDepth > 0) {
        if (style.nestedBlockComments && ch === "/" && next === "*") {
          blockCommentDepth++;
          blank(i);
          blank(i + 1);
          i++;
          continue;
        }
        if (ch === "*" && next === "/") {
          blockCommentDepth--;
          blank(i);
          blank(i + 1);
          i++;
          continue;
        }
        blank(i);
        continue;
      }

      if (rawHashes >= 0) {
        blank(i);
        if (ch === '"') {
          let matched = 0;
          while (matched < rawHashes && raw[i + 1 + matched] === "#") matched++;
          if (matched === rawHashes) {
            for (let h = 1; h <= rawHashes; h++) blank(i + h);
            i += rawHashes;
            rawHashes = -1;
          }
        }
        continue;
      }

      if (inBacktick) {
        blank(i);
        if (ch === "\\" && i + 1 < raw.length) {
          blank(i + 1);
          i++;
        } else if (ch === "`") {
          inBacktick = false;
        }
        continue;
      }

      if (inDouble) {
        blank(i);
        if (ch === "\\" && i + 1 < raw.length) {
          blank(i + 1);
          i++;
        } else if (ch === '"') {
          inDouble = false;
        }
        continue;
      }

      if (inSingle) {
        blank(i);
        if (ch === "\\" && i + 1 < raw.length) {
          blank(i + 1);
          i++;
        } else if (ch === "'") {
          inSingle = false;
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        for (let k = i; k < raw.length; k++) blank(k);
        break;
      }

      if (ch === "/" && next === "*") {
        blockCommentDepth = 1;
        blank(i);
        blank(i + 1);
        i++;
        continue;
      }

      if (style.rustRawStrings && ch === "r" && (next === '"' || next === "#")) {
        let hashes = 0;
        let k = i + 1;
        while (k < raw.length && raw[k] === "#") {
          hashes++;
          k++;
        }
        if (raw[k] === '"') {
          for (let j = i; j <= k; j++) blank(j);
          rawHashes = hashes;
          i = k;
          continue;
        }
      }

      if (ch === '"') {
        inDouble = true;
        blank(i);
        continue;
      }

      if (style.singleQuotedStrings && ch === "'") {
        inSingle = true;
        blank(i);
        continue;
      }

      if (style.backtickStrings && ch === "`") {
        inBacktick = true;
        blank(i);
        continue;
      }

      if (ch === "{") {
        depth++;
        if (!openedBrace) {
          openedBrace = true;
          minDepthAfterOpen = depth;
        }
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        if (openedBrace && depth < minDepthAfterOpen) minDepthAfterOpen = depth;
      }
    }

    out[li] = {
      code: chars ? chars.join("") : raw,
      startDepth,
      endDepth: depth,
      openedBrace,
      minDepthAfterOpen: openedBrace ? minDepthAfterOpen : depth,
    };
  }

  return out;
}
