import type { ThreadView } from "@ace/protocol";
import { ThreadId } from "@ace/protocol";

/** Host test observes only the streaming thread's live UI admissions. */
export const ADMISSIONS_THREAD_ID = "stream-thread";
/** Decoded probe text bound; longer queries are rejected at the schema boundary. */
export const ADMISSIONS_PROBE_MAX_LENGTH = 512;

export type AdmissionsQuery = { threadId: string; probe: string };
export type AdmissionsQueryError = { status: 400 | 404 | 405; error: string };
export type AdmissionsQueryResult =
  | { ok: true; threadId: string; probe: string }
  | ({ ok: false } & AdmissionsQueryError);

/**
 * Pure query validation for `GET /admissions`. Uses only the public
 * `ThreadId` schema; no fake-daemon internals. Returns 4xx on any
 * malformed or unsupported thread/query so the host test fails loudly.
 */
export function parseAdmissionsRequest(
  requestUrl: string | undefined,
  method: string | undefined,
): AdmissionsQueryResult {
  if (method !== undefined && method !== "GET")
    return { ok: false, status: 405, error: "method_not_allowed" };
  if (requestUrl === undefined || requestUrl.length === 0)
    return { ok: false, status: 400, error: "missing_url" };
  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return { ok: false, status: 400, error: "invalid_url" };
  }
  if (url.pathname !== "/admissions") return { ok: false, status: 404, error: "not_found" };
  const threadRaw = url.searchParams.get("threadId");
  if (threadRaw === null || threadRaw.length === 0)
    return { ok: false, status: 400, error: "missing_threadId" };
  try {
    ThreadId.parse(threadRaw);
  } catch {
    return { ok: false, status: 400, error: "invalid_threadId" };
  }
  if (threadRaw !== ADMISSIONS_THREAD_ID)
    return { ok: false, status: 404, error: "unsupported_thread" };
  const probeRaw = url.searchParams.get("probe");
  if (probeRaw === null) return { ok: false, status: 400, error: "missing_probe" };
  if (probeRaw.length === 0) return { ok: false, status: 400, error: "empty_probe" };
  if (probeRaw.length > ADMISSIONS_PROBE_MAX_LENGTH)
    return { ok: false, status: 400, error: "probe_too_long" };
  return { ok: true, threadId: threadRaw, probe: probeRaw };
}

/**
 * Canonical admitted user inputs whose exact text equals `probe`, in
 * snapshot `itemOrder`. Uses only the public `ThreadView` model:
 * `items` entries with `type: "message"`, `role: "user"`, non-synthetic,
 * and a stable `origin.commandId`. One entry per matching item, so a
 * repeated probe yields every admission instead of a deduped single ID.
 * Returns IDs only, never tokens or message contents.
 */
export function admissionCommandIds(view: ThreadView | undefined, probe: string): string[] {
  if (view === undefined) return [];
  const found: string[] = [];
  for (const id of view.itemOrder) {
    const item = view.items[id];
    if (item === undefined || item.type !== "message") continue;
    if (item.role !== "user") continue;
    if (item.synthetic) continue;
    const commandId = item.origin?.commandId;
    if (typeof commandId !== "string" || commandId.length === 0) continue;
    if (item.parts.length === 0) continue;
    let text = "";
    let pureText = true;
    for (const part of item.parts) {
      if (part.type !== "text") {
        pureText = false;
        break;
      }
      text += part.text;
    }
    if (!pureText) continue;
    if (text !== probe) continue;
    found.push(commandId);
  }
  return found;
}
