import type { MaintenanceGate } from "@ace/service";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AceAccountHandover,
  AceAccountLoginStart,
  AppUpdateReport,
  MachineCodeChange,
  PairingRedemption,
  type Device,
} from "@ace/protocol";
import { AccessError, RemoteAuth } from "./remote-auth.ts";
import { allows } from "./devices.ts";
import { issuePairing } from "./pairing-issue.ts";

async function body(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4096) throw new AccessError(413, "Request too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AccessError(400, "JSON object required");
  }
}
/**
 * Routes a web app served from another origin may call with the daemon's token: paired devices,
 * pairing and revoking. Only origins on the allowlist (`web-origins.ts`) get CORS headers, so other
 * sites can neither preflight these routes nor read any response. The token travels only in the
 * Authorization header and no cookie is ever accepted, so no credentials mode is granted. Pairing
 * redemption, tickets and status use this same explicit allowlist.
 */
function crossOrigin(path: string): boolean {
  return (
    accountPath(path) ||
    path === "/v1/status" ||
    path === "/v1/pair" ||
    path === "/v1/tickets" ||
    path === "/v1/devices" ||
    path === "/v1/pairings" ||
    /^\/v1\/devices\/[^/]+$/.test(path)
  );
}
/**
 * This machine's ace account and machine code (ADR 0111), for the hosted web app and dev:web on
 * the same allowlist. Each still needs an admin credential, and signing in or out the host's.
 */
function accountPath(path: string): boolean {
  return (
    path === "/v1/ace-account" || path === "/v1/ace-account/login" || path === "/v1/machine-code"
  );
}

export interface AccessHttpOptions {
  shutdown?: import("./shutdown-receipt.ts").ShutdownControl;
  auth: RemoteAuth;
  authenticate: (token: string) => Device | undefined;
  pairing: () => import("./pairing-issue.ts").PairingConnection | undefined;
  /** Origins whose pages may read the cross-origin routes. */
  allowedOrigins: ReadonlySet<string>;
  /** Origin of the web app new pairing links open; the daemon's own when it resolves undefined. */
  pairingApp?: () => Promise<string | undefined>;
  sourceAddress?: (request: IncomingMessage) => string;
  maintenance?: MaintenanceGate;
  /** Where the desktop app reports its update status (host token only). */
  appUpdate?: import("./app-update-board.ts").AppUpdateBoard;
  /** The update's leased hold (`update-hold.ts`); without it the update route holds plainly. */
  updateHold?: import("./update-hold.ts").UpdateHold;
  version?: string;
  serviceStatus?: () => readonly import("./services/startup.ts").ServiceStatus[];
  /** Event-loop delay, so a watchdog can tell a busy daemon from a hung one. */
  eventLoop?: () => import("./loop-monitor.ts").LoopStatus;
  ready?: () => boolean;
  remoteStatus?: () => import("@ace/protocol").RemoteAccessStatus;
  /** Live provider processes per thread and whether each is busy, idle-warm or releasing. */
  providerProcesses?: () => readonly import("./engine/provider-release.ts").ProviderProcess[];
  /** This machine's ace account and machine code (ADR 0111). */
  account?: () => import("./account-access/machine-account.ts").MachineAccount | undefined;
}
export function accessHttp({
  shutdown,
  auth,
  authenticate,
  pairing,
  allowedOrigins,
  pairingApp,
  sourceAddress = (request) => request.socket.remoteAddress ?? "unknown",
  maintenance,
  appUpdate,
  updateHold,
  version = "development",
  serviceStatus,
  eventLoop,
  ready = () => true,
  remoteStatus,
  providerProcesses,
  account,
}: AccessHttpOptions) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Vary", "Origin");
      const path = request.url ?? "";
      if (crossOrigin(path)) {
        const origin = request.headers.origin;
        const allowed = origin !== undefined && allowedOrigins.has(origin);
        if (allowed) response.setHeader("Access-Control-Allow-Origin", origin);
        if (request.method === "OPTIONS") {
          request.resume();
          if (!allowed) throw new AccessError(403, "Origin not allowed");
          response.setHeader(
            "Access-Control-Allow-Methods",
            accountPath(path) ? "GET, POST, PUT, DELETE" : "GET, POST, DELETE",
          );
          response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
          response.setHeader("Access-Control-Max-Age", "600");
          response.statusCode = 204;
          response.end();
          return;
        }
      }
      // Match exact paths. Credentials and fragments never belong in HTTP URLs.
      const token = request.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1] ?? "";
      const actor = () => authenticate(token);
      let result: unknown;
      if (path === "/v1/pair" && request.method === "POST") {
        auth.pairingAttempt(sourceAddress(request));
        const data = PairingRedemption.safeParse(await body(request));
        if (!data.success) throw new AccessError(400, "Invalid pairing redemption");
        result = auth.redeem(data.data.code, data.data.name, data.data.installId);
      } else if (path === "/v1/tickets" && request.method === "POST") {
        const device = auth.deviceBearer(token);
        if (!device) throw new AccessError(401, "Device token required");
        result = auth.ticket(device);
      } else {
        auth.requireAdmin(actor());
        if (path === "/v1/status" && request.method === "GET") {
          result = {
            running: true,
            ready: ready(),
            version,
            remote: directPairing(pairing()) ?? null,
            ...(remoteStatus ? { remoteAccess: remoteStatus() } : {}),
            ...(serviceStatus ? { services: serviceStatus() } : {}),
            ...(eventLoop ? { eventLoop: eventLoop() } : {}),
            ...(providerProcesses ? { providers: providerProcesses() } : {}),
          };
        } else if (path === "/v1/stop" && request.method === "POST" && shutdown) {
          if (!auth.local(token)) throw new AccessError(403, "Host token required");
          maintenance?.enter("stop");
          result = shutdown.request();
          response.once("finish", () => shutdown.start());
        } else if (
          (path === "/v1/maintenance" || path === "/v1/maintenance/update") &&
          maintenance
        ) {
          if (!auth.local(token)) throw new AccessError(403, "Host token required");
          // The tray's pause is the person's hold; an update's drain holds admission on its own.
          // A drain renews its lease with each POST; one that stops renewing lets go on its own.
          const update = path === "/v1/maintenance/update";
          if (request.method === "POST")
            result = update
              ? (updateHold?.renew() ?? maintenance.enter("update"))
              : maintenance.enter("user");
          else if (request.method === "DELETE")
            result = update
              ? (updateHold?.release() ?? maintenance.leave("update"))
              : maintenance.leave("user");
          else if (request.method === "GET") result = maintenance.status();
          else throw new AccessError(405, "Unsupported method");
        } else if (path === "/v1/app-update" && appUpdate) {
          if (!auth.local(token)) throw new AccessError(403, "Host token required");
          if (request.method === "PUT") {
            const report = AppUpdateReport.safeParse(await body(request));
            if (!report.success) throw new AccessError(400, "Invalid update report");
            result = appUpdate.set(report.data);
          } else if (request.method === "DELETE") result = appUpdate.clear();
          else throw new AccessError(405, "Unsupported method");
        } else if (path === "/v1/pairings" && request.method === "POST") {
          // Awaits come first: the address is read again right before the code is issued, since
          // remote access can change or turn off while they wait.
          const app = await pairingApp?.();
          const input = pairing() ? await body(request) : undefined;
          const creator = actor();
          const { id, url, expiresAt } = issuePairing(
            auth,
            pairing(),
            input,
            // The host token holds every scope; a device grants only what it has.
            (scope) => auth.local(token) || allows(creator, scope),
            app,
          );
          result = { url, expiresAt, id };
        } else if (
          (path === "/v1/ace-account" ||
            path === "/v1/ace-account/login" ||
            path === "/v1/machine-code") &&
          account
        )
          result = await accountRoute(path, request, account(), auth.local(token));
        else if (path === "/v1/devices" && request.method === "GET") result = auth.list();
        else if (path.startsWith("/v1/devices/") && request.method === "DELETE") {
          if (!auth.revoke(path.slice("/v1/devices/".length)))
            throw new AccessError(404, "Active device not found");
          result = { revoked: true };
        } else throw new AccessError(404, "Unknown endpoint");
      }
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      response.statusCode = error instanceof AccessError ? error.status : 500;
      response.end(
        JSON.stringify({ error: error instanceof AccessError ? error.message : "Request failed" }),
      );
    });
  };
}

/**
 * The session a sign-in or sign-out is conditional on: `If-Match: "<sessionId>"` (that session)
 * or `If-None-Match: *` (no session), from the account status the caller read. Neither header:
 * unconditional, as `ace login`, `ace logout` and Settings' explicit Switch are.
 */
function sessionCondition(request: IncomingMessage): { session: string | null } | undefined {
  const match = request.headers["if-match"];
  if (typeof match === "string") {
    const id = /^"([A-Za-z0-9_-]{1,64})"$/.exec(match.trim())?.[1];
    if (!id) throw new AccessError(400, "If-Match names one ace session id");
    return { session: id };
  }
  if (request.headers["if-none-match"]?.trim() === "*") return { session: null };
  return undefined;
}

/**
 * The machine's ace account and machine code (ADR 0111). Signing in and out is for this
 * machine only (the host token: the desktop app or `ace`); any admin may set or clear the code.
 */
async function accountRoute(
  path: string,
  request: IncomingMessage,
  account: import("./account-access/machine-account.ts").MachineAccount | undefined,
  host: boolean,
): Promise<unknown> {
  if (!account) throw new AccessError(503, "ace account is unavailable");
  if (path === "/v1/machine-code") {
    if (request.method === "PUT") {
      const change = MachineCodeChange.safeParse(await body(request));
      if (!change.success) throw new AccessError(400, "A machine code has 4 to 128 characters.");
      return account.setMachineCode(change.data.code);
    }
    if (request.method === "DELETE") return account.clearMachineCode();
    throw new AccessError(405, "Unsupported method");
  }
  if (path === "/v1/ace-account" && request.method === "GET") return account.status();
  if (!host) throw new AccessError(403, "Host token required");
  if (path === "/v1/ace-account/login" && request.method === "POST") {
    const start = AceAccountLoginStart.safeParse(await body(request));
    if (!start.success) throw new AccessError(400, "Invalid ace account address");
    return account.startLogin(start.data.origin);
  }
  if (path === "/v1/ace-account" && request.method === "PUT") {
    const handover = AceAccountHandover.safeParse(await body(request));
    if (!handover.success) throw new AccessError(400, "Invalid ace session");
    return account.handover(handover.data.origin, handover.data.token, sessionCondition(request));
  }
  if (path === "/v1/ace-account" && request.method === "DELETE")
    return account.signOut(sessionCondition(request));
  throw new AccessError(405, "Unsupported method");
}

/** The daemon's own HTTPS address and pin for status; a relay route is reported apart. */
function directPairing(
  connection: import("./pairing-issue.ts").PairingConnection | undefined,
): { origin: string; fingerprint: string } | undefined {
  return connection?.origin === undefined
    ? undefined
    : { origin: connection.origin, fingerprint: connection.fingerprint };
}
