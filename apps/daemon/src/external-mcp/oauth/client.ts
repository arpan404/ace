import type { OutsideClientKind } from "@ace/protocol";

/** A client /authorize can show and redirect to, however it registered. */
export interface OAuthClient {
  kind: Exclude<OutsideClientKind, "cli">;
  clientId: string;
  name: string;
  /** The client_id's host for a metadata document; null for DCR (unverified). */
  domain: string | null;
  redirectUris: readonly string[];
}
/** Why a client can't sign in, said to the person on the sign-in page. */
export type ClientProblem = { problem: string };
