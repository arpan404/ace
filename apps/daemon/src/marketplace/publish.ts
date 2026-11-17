import { z } from "zod";
import {
  MarketApiError,
  MarketDone,
  MarketDraft,
  MarketMe,
  MarketOwnEntry,
  MarketProfile,
  MarketScanReport,
  MarketSignals,
  MarketVerificationStatus,
  PublishAccepted,
  type MarketPublishAction,
  type MarketPublishAnswer,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { draftArchive, pictureBytes } from "./draft-files.ts";
import { MarketHttpError, type MarketHttp } from "./http.ts";
import { Refused } from "./prepare.ts";

/*
 * Publishing through the daemon (ADR 0174 §2, §11): a thin proxy from each `publish` action to
 * its Worker route under `/v1/me`, every answer parsed with the protocol's schema and every
 * Worker error mapped to a `MarketErrorCode`. A market grant is minted for each action through
 * the machine's signed-in ace account and goes only as `Authorization` to the market's origin;
 * it is held for that request alone, never written, logged or answered.
 */

/** Mints a market grant for one action; undefined when no ace account is signed in. */
export type MarketGrantPort = () => Promise<string | undefined>;

type ErrorResult = Extract<MarketResult, { op: "error" }>;
const failure = (code: ErrorResult["code"], message: string, extra: Partial<ErrorResult> = {}) =>
  ({ op: "error", code, message: message.slice(0, 2000), ...extra }) satisfies ErrorResult;

export const signedOut = () => failure("signed_out", "Sign in to publish.");

const segment = encodeURIComponent;
const entryPath = (action: { type: string; name: string }) =>
  `/v1/me/entries/${segment(action.type)}/${segment(action.name)}`;
const versionPath = (action: { type: string; name: string; version: string }) =>
  `${entryPath(action)}/versions/${segment(action.version)}`;

/** The Worker's 202 for what it took and holds: a listing edit for review, a withdrawal. */
const PendingAnswer = z.object({
  status: z.literal("pending"),
  scan: MarketScanReport.optional(),
});

/** One Worker request an action makes, and the answer kind its body reads as. */
interface Call {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  json?: unknown;
  bytes?: { body: Uint8Array; type: string };
  answer: MarketPublishAnswer["kind"];
  /** What a `{status: "pending"}` answer means for this call. */
  pending?: "listing" | "withdrawal";
}

/** The Worker's body as the answer kind; `{status: "done"}` reads as done for any write. */
function readAnswer(call: Call, body: unknown): MarketPublishAnswer | undefined {
  const kind = call.answer;
  if (MarketDone.safeParse(body).success) return { kind: "done" };
  if (call.pending) {
    const pending = PendingAnswer.safeParse(body);
    if (pending.success)
      return {
        kind: "pending",
        what: call.pending,
        ...(pending.data.scan ? { scan: pending.data.scan } : {}),
      };
  }
  const read = <T>(schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  };
  switch (kind) {
    case "done":
      return { kind: "done" };
    case "published": {
      const accepted = read(PublishAccepted);
      if (!accepted) return undefined;
      const { type, name, version, held } = accepted;
      return { kind: "published", type, name, version, held: held ?? false };
    }
    case "me": {
      const me = read(MarketMe);
      return me && { kind, me };
    }
    case "entry": {
      const entry = read(MarketOwnEntry);
      return entry && { kind, entry };
    }
    case "profile": {
      const profile = read(MarketProfile);
      return profile && { kind, profile };
    }
    case "draft": {
      const draft = read(MarketDraft);
      return draft && { kind, draft };
    }
    case "signals": {
      const signals = read(MarketSignals);
      return signals && { kind, signals };
    }
    case "verification": {
      const verification = read(MarketVerificationStatus);
      return verification && { kind, verification };
    }
  }
}

const codes: Record<z.infer<typeof MarketApiError>["error"], ErrorResult["code"]> = {
  unauthorized: "signed_out",
  reauth: "reauth",
  email_unverified: "refused",
  suspended: "suspended",
  forbidden: "forbidden",
  not_found: "not_found",
  invalid: "invalid",
  refused: "refused",
  blocked: "blocked",
  conflict: "conflict",
  too_large: "invalid",
  quota: "quota",
  busy: "busy",
  unavailable: "unavailable",
  method: "failed",
};

/** A Worker error as the daemon's: its code, its words, its problems and scan. */
export function workerError(status: number, body: unknown): ErrorResult {
  const parsed = MarketApiError.safeParse(body);
  if (!parsed.success) {
    if (status === 401) return signedOut();
    if (status === 403) return failure("forbidden", "This account can't do that.");
    if (status === 404) return failure("not_found", "The market has nothing there.");
    if (status === 409) return failure("conflict", "That conflicts with what the market has.");
    if (status === 429) return failure("busy", "The market is busy; try again shortly.");
    return failure("failed", `The market answered ${status}`);
  }
  const { error, message, problems, scan } = parsed.data;
  const code = codes[error];
  const words =
    code === "reauth"
      ? "Sign in again to do this."
      : code === "signed_out"
        ? "Sign in to publish."
        : message || `The market refused it (${error})`;
  return failure(code, words, {
    ...(problems?.length ? { problems: problems.slice(0, 200) } : {}),
    ...(scan ? { scan } : {}),
  });
}

/** The Worker requests one action makes, in order; the last one's answer is the action's. */
async function callsOf(
  action: MarketPublishAction,
  archive: Uint8Array | undefined,
): Promise<Call[]> {
  switch (action.action) {
    case "me":
      return [{ method: "GET", path: "/v1/me", answer: "me" }];
    case "entry":
      return [{ method: "GET", path: entryPath(action), answer: "entry" }];
    case "createProfile":
      return [{ method: "POST", path: "/v1/me/profile", json: action.profile, answer: "profile" }];
    case "editProfile":
      return [{ method: "PUT", path: "/v1/me/profile", json: action.profile, answer: "profile" }];
    case "changeHandle":
      return [
        {
          method: "PUT",
          path: "/v1/me/handle",
          json: { handle: action.handle },
          answer: "profile",
        },
      ];
    case "setAvatar": {
      const picture = pictureBytes(action.image);
      return [
        {
          method: "PUT",
          path: "/v1/me/avatar",
          bytes: { body: picture.bytes, type: picture.type },
          answer: "profile",
        },
      ];
    }
    case "setPins":
      return [
        {
          method: "PUT",
          path: "/v1/me/pins",
          json: { entries: action.entries },
          answer: "profile",
        },
      ];
    case "draftCreate": {
      const query = new URLSearchParams({
        type: action.type,
        name: action.name,
        version: action.version,
      });
      const calls: Call[] = [
        {
          method: "POST",
          path: `/v1/me/drafts?${query}`,
          bytes: {
            body: archive ?? (await draftArchive(action.source)),
            type: "application/x-tar",
          },
          answer: "draft",
        },
      ];
      if (action.changelog !== undefined)
        calls.push({
          method: "PATCH",
          path: "/v1/me/drafts/{id}",
          json: { changelog: action.changelog },
          answer: "draft",
        });
      return calls;
    }
    case "draftRead":
      return [{ method: "GET", path: `/v1/me/drafts/${action.id}`, answer: "draft" }];
    case "draftUpdate": {
      const path = `/v1/me/drafts/${action.id}`;
      const calls: Call[] = [];
      if (action.source)
        calls.push({
          method: "PUT",
          path,
          bytes: {
            body: archive ?? (await draftArchive(action.source)),
            type: "application/x-tar",
          },
          answer: "draft",
        });
      if (action.version !== undefined || action.changelog !== undefined)
        calls.push({
          method: "PATCH",
          path,
          json: {
            ...(action.version !== undefined ? { version: action.version } : {}),
            ...(action.changelog !== undefined ? { changelog: action.changelog } : {}),
          },
          answer: "draft",
        });
      return calls.length ? calls : [{ method: "GET", path, answer: "draft" }];
    }
    case "draftCheck":
      // Answered on this machine (`check.ts`); nothing about it goes to the market.
      throw new Refused("A draft is checked on this machine, not by the market");
    case "draftDelete":
      return [{ method: "DELETE", path: `/v1/me/drafts/${action.id}`, answer: "done" }];
    case "draftPublish":
      return [{ method: "POST", path: `/v1/me/drafts/${action.id}/publish`, answer: "published" }];
    case "listing":
      return [
        {
          method: "PUT",
          path: `${entryPath(action)}/listing`,
          json: action.listing,
          answer: "done",
          pending: "listing",
        },
      ];
    case "preview": {
      const picture = pictureBytes(action.image);
      return [
        {
          method: "PUT",
          path: `${entryPath(action)}/previews/${action.index}`,
          bytes: { body: picture.bytes, type: picture.type },
          answer: "entry",
        },
      ];
    }
    case "changelog":
      return [
        {
          method: "PUT",
          path: `${versionPath(action)}/changelog`,
          json: { text: action.text },
          answer: "entry",
        },
      ];
    case "latest":
      return [
        {
          method: "PUT",
          path: `${entryPath(action)}/latest`,
          json: { version: action.version },
          answer: "entry",
        },
      ];
    case "deprecate":
      return [
        action.note === null
          ? { method: "DELETE", path: `${versionPath(action)}/deprecation`, answer: "entry" }
          : {
              method: "PUT",
              path: `${versionPath(action)}/deprecation`,
              json: { note: action.note },
              answer: "entry",
            },
      ];
    case "withdraw":
      return [
        {
          method: "POST",
          path:
            action.version === undefined
              ? `${entryPath(action)}/withdraw`
              : `${versionPath({ ...action, version: action.version })}/withdraw`,
          json: { reason: action.reason },
          answer: "done",
          pending: "withdrawal",
        },
      ];
    case "deleteEntry":
      return [{ method: "DELETE", path: entryPath(action), answer: "done" }];
    case "visibility":
      return [
        {
          method: "PUT",
          path: `${entryPath(action)}/visibility`,
          json: { visibility: action.visibility },
          answer: "entry",
        },
      ];
    case "archive":
      return [
        {
          method: "PUT",
          path: `${entryPath(action)}/archived`,
          json: { archived: action.archived },
          answer: "entry",
        },
      ];
    case "transfer":
      return [
        {
          method: "POST",
          path: `${entryPath(action)}/transfer`,
          json: { to: action.to },
          // The Worker answers the offer it made; the app reads the transfer from `me`.
          answer: "done",
        },
      ];
    case "transferAnswer":
      return [
        {
          method: "POST",
          path: `/v1/me/transfers/${action.id}/${action.accept ? "accept" : "decline"}`,
          answer: "me",
        },
      ];
    case "signals":
      return [{ method: "GET", path: `${entryPath(action)}/signals`, answer: "signals" }];
    case "verification":
      return [{ method: "GET", path: "/v1/me/verification", answer: "verification" }];
    case "applyVerification": {
      const { action: _action, ...claims } = action;
      return [
        { method: "POST", path: "/v1/me/verification", json: claims, answer: "verification" },
      ];
    }
    case "checkVerification":
      return [{ method: "POST", path: "/v1/me/verification/check", answer: "verification" }];
    case "appeal":
      return [
        {
          method: "POST",
          path: `${versionPath(action)}/appeal`,
          json: {
            note: action.note,
            ...(action.replacement ? { replacement: action.replacement } : {}),
          },
          answer: "entry",
        },
      ];
  }
}

/** One `publish` action, its grant minted for it alone. */
export async function publishAction(
  ports: {
    http: MarketHttp | undefined;
    grant: MarketGrantPort | undefined;
    /** A draft's archive already read and checked on this machine (`check.ts`). */
    archive?: Uint8Array | undefined;
  },
  action: MarketPublishAction,
): Promise<MarketResult> {
  const http = ports.http;
  if (!http) return failure("unavailable", "market.acehq.dev is turned off");
  let calls: Call[];
  try {
    // Files are read first, so a folder that can't be published asks for no grant.
    calls = await callsOf(action, ports.archive);
  } catch (error) {
    if (error instanceof Refused) return failure(error.code, error.message);
    throw error;
  }
  let grant: string | undefined;
  try {
    grant = await ports.grant?.();
  } catch (error) {
    return failure(
      "unavailable",
      `ace's account service can't give a market grant: ${error instanceof Error ? error.message : "no answer"}`,
    );
  }
  if (!grant) return signedOut();
  let answer: MarketPublishAnswer | undefined;
  let draftId: string | undefined;
  for (const call of calls) {
    const path = call.path.replace("{id}", draftId ?? "");
    const headers: Record<string, string> = { authorization: `Bearer ${grant}` };
    let body: Uint8Array | string | undefined;
    if (call.bytes) {
      headers["content-type"] = call.bytes.type;
      body = call.bytes.body;
    } else if (call.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(call.json);
    }
    let reply;
    try {
      reply = await http.send(
        call.method,
        path,
        body === undefined ? { headers } : { headers, body },
      );
    } catch (error) {
      if (error instanceof MarketHttpError) return failure("unavailable", error.message);
      throw error;
    }
    if (reply.status < 200 || reply.status >= 300) return workerError(reply.status, reply.body);
    answer = readAnswer(call, reply.body);
    if (!answer) return failure("failed", "The market's answer isn't in a form this build reads");
    if (answer.kind === "draft") draftId = answer.draft.id;
  }
  return answer ? { op: "publish", answer } : failure("failed", "Nothing was asked of the market");
}
