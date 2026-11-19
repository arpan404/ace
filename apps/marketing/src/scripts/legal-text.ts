/*
 * A legal paragraph as runs to render: plain text, `code` written in backticks, and the
 * contact address, which becomes a mail link. The words themselves are never changed.
 */

export type Run = { kind: "text" | "code"; text: string } | { kind: "email"; text: string };

export function textRuns(text: string, email: string): Run[] {
  const runs: Run[] = [];
  for (const [index, piece] of text.split("`").entries()) {
    if (index % 2 === 1) {
      runs.push({ kind: "code", text: piece });
      continue;
    }
    for (const [at, part] of piece.split(email).entries()) {
      if (at > 0) runs.push({ kind: "email", text: email });
      if (part) runs.push({ kind: "text", text: part });
    }
  }
  return runs;
}
