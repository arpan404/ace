import { z } from "zod";
import type { BrowserAuthChallenge } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";

const AuthRequired = z.object({
  requestId: z.string(),
  authChallenge: z.object({
    origin: z.string(),
    scheme: z.string().optional(),
    realm: z.string().optional(),
  }),
});
const Navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) });
export interface SignInCredentials {
  username: string;
  password: string;
}

/**
 * A tab's pending HTTP sign-in (basic or digest auth), paused by CDP Fetch until the person
 * answers. Credentials pass straight to `Fetch.continueWithAuth` for that one request; nothing
 * here keeps them. A new challenge replaces (and cancels) an older one; a committed page ends it.
 */
export class SignInPrompt {
  private pending: { challenge: BrowserAuthChallenge; requestId: string } | undefined;
  private cdp: BrowserCdp;
  private tabId: string;
  private id: () => string;
  private changed: () => void;
  private stops: (() => void)[] = [];
  constructor(cdp: BrowserCdp, tabId: string, id: () => string, changed: () => void) {
    this.cdp = cdp;
    this.tabId = tabId;
    this.id = id;
    this.changed = changed;
    const required = (raw: unknown) => this.required(raw);
    const navigated = (raw: unknown) => {
      const frame = Navigated.safeParse(raw);
      if (frame.success && !frame.data.frame.parentId) this.forget();
    };
    cdp.on("Fetch.authRequired", required);
    cdp.on("Page.frameNavigated", navigated);
    this.stops.push(
      () => cdp.off("Fetch.authRequired", required),
      () => cdp.off("Page.frameNavigated", navigated),
    );
  }
  challenge(): BrowserAuthChallenge | undefined {
    return this.pending?.challenge;
  }
  /** The person's answer; without credentials the sign-in is cancelled and the page shows 401. */
  async answer(authId: string, credentials?: SignInCredentials): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.challenge.authId !== authId)
      throw new Error("Sign-in no longer pending");
    this.pending = undefined;
    this.changed();
    await this.cdp.send("Fetch.continueWithAuth", {
      requestId: pending.requestId,
      authChallengeResponse: credentials
        ? { response: "ProvideCredentials", ...credentials }
        : { response: "CancelAuth" },
    });
  }
  /** The tab's page went away (a new target, a crash): its paused request went with it. */
  forget(): void {
    if (!this.pending) return;
    this.pending = undefined;
    this.changed();
  }
  close(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.pending = undefined;
  }
  private required(raw: unknown): void {
    const parsed = AuthRequired.safeParse(raw);
    if (!parsed.success) return;
    const previous = this.pending;
    if (previous)
      void this.cdp
        .send("Fetch.continueWithAuth", {
          requestId: previous.requestId,
          authChallengeResponse: { response: "CancelAuth" },
        })
        .catch(() => {});
    const { authChallenge } = parsed.data;
    this.pending = {
      requestId: parsed.data.requestId,
      challenge: {
        authId: `${this.tabId}-auth-${this.id()}`,
        tabId: this.tabId,
        origin: authChallenge.origin.slice(0, 8192),
        ...(authChallenge.realm ? { realm: authChallenge.realm.slice(0, 1024) } : {}),
        ...(authChallenge.scheme ? { scheme: authChallenge.scheme.slice(0, 64) } : {}),
      },
    };
    this.changed();
  }
}
