import type { PreviewGatewayStatus } from "@ace/protocol";
import type { BrowserFailure } from "@ace/ui-core";

/** The daemon's refusal code, from a rejected `forward` or `link` (its message). */
const codeOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why forwarding `port` failed, in a sentence a person can act on. */
export function forwardFailure(error: unknown, port: number): string {
  const code = codeOf(error);
  switch (code) {
    case "forbidden":
      return `Only the daemon's own token can preview a port, so this device can't preview port ${port}.`;
    case "preview_owned_by_another_thread":
      return `Another thread already previews port ${port}. Stop it there first.`;
    case "preview_limit":
      return "The daemon already previews as many ports as it allows. Stop previewing one first.";
    case "preview_unavailable":
      return "This daemon runs no preview gateway, so it can't preview ports.";
    case "preview_refused":
      return `The daemon refused to preview port ${port}. Check that it's a port number a dev server listens on.`;
    default:
      return `The daemon couldn't preview port ${port} (${code}).`;
  }
}

/** Why signing in to a preview failed: the daemon wouldn't issue its link. */
export function signInFailure(error: unknown, port: number): BrowserFailure {
  const code = codeOf(error);
  switch (code) {
    case "forbidden":
      return {
        title: "This device can't open previews",
        detail:
          "Opening a dev server's preview needs operate access. Pair this device with operate access, or open the preview from the desktop app.",
        code,
      };
    case "preview_not_found":
      return {
        title: `Port ${port} isn't previewed for this thread`,
        detail: "Previewing stopped, or the daemon restarted. Preview the port again.",
        code,
      };
    case "preview_unavailable":
      return {
        title: "This daemon runs no preview gateway",
        detail: "Dev servers can't be previewed here. Open them in the Browser instead.",
        code,
      };
    default:
      return {
        title: "Couldn't sign in to the preview",
        detail: "The daemon refused to sign this preview in. Reload to try again.",
        code,
      };
  }
}

/** What the preview gateway's refusal page reported, once signing in again didn't help. */
export function gatewayFailure(status: PreviewGatewayStatus, port: number): BrowserFailure {
  const code = `HTTP ${status.status} · ${status.reason}`;
  switch (status.reason) {
    case "signed_out":
      return {
        title: "The preview didn't keep its sign-in",
        detail:
          "The preview gateway never received its sign-in cookie. This browser may block cookies in embedded pages (Safari does); open the preview in your browser instead.",
        code,
      };
    case "session_expired":
      return {
        title: "The preview's sign-in expired",
        detail: "Reload to sign in again.",
        code,
      };
    case "link_invalid":
      return {
        title: "The preview's sign-in link expired",
        detail: "Sign-in links work once, within a minute. Reload to get a new one.",
        code,
      };
    case "not_previewed":
      return {
        title: `Port ${port} is no longer previewed`,
        detail:
          "The daemon stopped previewing this port, or restarted. Preview the port again from the Preview tab.",
        code,
      };
    case "upstream_unavailable":
      return {
        title: `Nothing answered on port ${port}`,
        detail:
          "The preview is signed in, but its dev server didn't answer. It may have stopped, still be starting, or listen on another port.",
        code,
      };
  }
}

/** Refusals that signing in once more can fix: a missing, expired or spent sign-in. */
export function signInAgainHelps(status: PreviewGatewayStatus): boolean {
  return (
    status.reason === "signed_out" ||
    status.reason === "session_expired" ||
    status.reason === "link_invalid"
  );
}
