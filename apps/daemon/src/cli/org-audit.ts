import { spawn } from "node:child_process";
import { CliFailure, usageFailure } from "./output.ts";
import { answerFailure, type SpadeExchange } from "./spade-call.ts";

/*
 * `ace org audit export|verify` (ADR 0206 §4.2): the org host's audit log as Spade exports it
 * (`GET /v1/org/audit/export`), and Spade's own offline check of a file
 * (`spade --verify-org-audit`), which exits 0 only when the log verifies.
 */

/** A `--from`/`--to` value: milliseconds since 1970, or a date. */
export function moment(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  const at = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isFinite(at) || at < 0)
    throw usageFailure(`${flag} takes a date or milliseconds since 1970.`, { argument: flag });
  return at;
}

const notBound = () =>
  new CliFailure("refused", "This machine's Spade doesn't belong to an organization.", undefined, {
    code: "not_found",
    hint: "Its owner gives it to one from Settings › Machine.",
  });

/** The log from `from` through `to`, as JSON Lines. */
export async function exportAudit(
  exchange: SpadeExchange,
  span: { from?: number | undefined; to?: number | undefined },
): Promise<string> {
  const query = new URLSearchParams();
  if (span.from !== undefined) query.set("from", String(span.from));
  if (span.to !== undefined) query.set("to", String(span.to));
  const path = `/v1/org/audit/export${query.size ? `?${query}` : ""}`;
  const answer = await exchange("GET", path);
  if (answer.status === 404) throw notBound();
  if (answer.status < 200 || answer.status >= 300) throw answerFailure(answer);
  return answer.body;
}

/** This host's own audit key, as its Spade gives it. */
export async function ownAuditKey(exchange: SpadeExchange): Promise<string> {
  const answer = await exchange("GET", "/v1/org");
  if (answer.status < 200 || answer.status >= 300) throw answerFailure(answer);
  let view: unknown;
  try {
    view = JSON.parse(answer.body);
  } catch {
    view = undefined;
  }
  const field = (name: string) =>
    view !== null && typeof view === "object" ? Reflect.get(view, name) : undefined;
  if (field("org") === null || field("org") === undefined) throw notBound();
  const key = field("auditKey");
  if (typeof key !== "string" || key === "")
    throw new CliFailure("failed", "This host's Spade has no audit key to check with.", undefined, {
      code: "failed",
      hint: "Pass the key the organization registered with --key.",
    });
  return key;
}

/** Spade's verdict on `file` against `key`: what it said, and whether it verified. */
export function verifyAudit(
  program: string,
  file: string,
  key: string,
): Promise<{ verified: boolean; said: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, ["--verify-org-audit", file, key], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (piece: string) => {
      if (out.length < 8192) out += piece;
    });
    child.stderr.setEncoding("utf8").on("data", (piece: string) => {
      if (err.length < 8192) err += piece;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // 2: Spade couldn't read the file or its arguments; that's no verdict on the log.
      if (code === 2)
        return reject(
          new CliFailure("failed", err.trim() || "Spade couldn't read that file.", undefined, {
            code: "failed",
          }),
        );
      resolve({ verified: code === 0, said: out.trim() || err.trim() });
    });
  });
}
