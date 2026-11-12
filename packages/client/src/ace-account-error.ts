/**
 * The account backend refused a call or couldn't be reached. Apart from the client
 * (`ace-account.ts`) so a page can tell a sign-out (401) without loading the client's schemas.
 */
export class AceAccountError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? "Sign in to ace again." : "Couldn't reach your ace account. Try again.");
    this.status = status;
  }
}
