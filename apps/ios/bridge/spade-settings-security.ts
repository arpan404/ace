import {
  parseSpadeSecurityMachine,
  spadePermissionSwitches,
  type SpadePermissionKey,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { spadeSecurityPage, type SpadeSecurityPageRow } from "./spade-settings-rows.ts";

/*
 * Settings › Spade › Security from the phone (ADR 0167; ADR 0171, amendment 7): the machine's
 * sandbox, the Permissions every bot follows unless it sets its own, the apps bots never use and
 * how bots decide. Each change is saved as it is made, and Spade answers it with the machine's
 * view as it now is, so the page shows that without reading again.
 */

const keys = spadePermissionSwitches.map((each) => each.key) as [
  SpadePermissionKey,
  ...SpadePermissionKey[],
];
/** An app's name as the person types it; Spade keeps the list as a whole. */
const app = z.string().trim().min(1).max(200);

export const spadeSecurityRequests = [
  z.object({ type: z.literal("spade.settings.permission"), key: z.enum(keys), on: z.boolean() }),
  z.object({ type: z.literal("spade.settings.neverApps"), apps: z.array(app).max(500) }),
  z.object({
    type: z.literal("spade.settings.autonomy"),
    autonomy: z.enum(["auto_review", "full_access"]),
  }),
] as const;
export type SecurityWrite = z.infer<(typeof spadeSecurityRequests)[number]>;

type Ask = (method: "GET" | "PUT", route: string, body?: unknown) => Promise<string>;
type Refusal = { ok: false; title: string; message: string };

/**
 * What ace's daemon, or Spade, answers a change only the person may make from a caller that
 * hasn't proved it is them (`spade-server` `security::attest::CONFIRM`).
 */
const standing = /^(Confirm your identity to continue|This is yours to do)/;

/**
 * The phone proves the person on its paired machine's socket by itself, so when that proof is
 * missing there is no Confirm it's you to offer here: only pairing again, or the computer.
 */
const theirs =
  "Only you can make this change. Pair this iPhone again from ace on your computer to make it here, or make it there.";

const sure = (body: string) => {
  const machine = parseSpadeSecurityMachine(body);
  if (!machine) throw new Error("Spade's security settings didn't make sense.");
  return spadeSecurityPage(machine);
};

export async function readSecurityPage(ask: Ask): Promise<SpadeSecurityPageRow> {
  return sure(await ask("GET", "/v1/security"));
}

const titleOf = (request: SecurityWrite): string => {
  switch (request.type) {
    case "spade.settings.permission": {
      const name = spadePermissionSwitches.find((each) => each.key === request.key)?.title ?? "it";
      return request.on ? `Couldn't turn on ${name}` : `Couldn't turn off ${name}`;
    }
    case "spade.settings.neverApps":
      return "Couldn't change the apps bots never use";
    case "spade.settings.autonomy":
      return "Couldn't change how bots decide";
  }
};

/** One change, answered with the page as Spade now holds it, or why it wasn't made. */
export async function writeSecurity(
  ask: Ask,
  request: SecurityWrite,
): Promise<{ ok: true; security: SpadeSecurityPageRow } | Refusal> {
  try {
    const body = await (() => {
      switch (request.type) {
        case "spade.settings.permission":
          return ask("PUT", "/v1/security/permissions", { key: request.key, on: request.on });
        case "spade.settings.neverApps":
          return ask("PUT", "/v1/security/never-apps", { apps: [...new Set(request.apps)] });
        case "spade.settings.autonomy":
          return ask("PUT", "/v1/security/autonomy", { autonomy: request.autonomy });
      }
    })();
    return { ok: true, security: sure(body) };
  } catch (error) {
    const said = (error instanceof Error && error.message) || "Try again.";
    return { ok: false, title: titleOf(request), message: standing.test(said) ? theirs : said };
  }
}

export const securityTypes = new Set<string>(
  spadeSecurityRequests.map((each) => each.shape.type.value),
);
export const isSecurityWrite = (request: { type: string }): request is SecurityWrite =>
  securityTypes.has(request.type);
