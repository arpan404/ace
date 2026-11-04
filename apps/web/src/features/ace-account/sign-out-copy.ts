/*
 * What signing out asks before it happens: a short question and one line. Signing out never
 * deletes anything, so the line says what stays or what stops.
 */

export interface SignOutQuestion {
  title: string;
  body: string;
  confirm: string;
}

/** Signing this app out of the person's ace account. */
export function accountSignOutQuestion(): SignOutQuestion {
  return {
    title: "Sign out?",
    body: "Your threads and drafts stay on this device.",
    confirm: "Sign out",
  };
}

/** Signing a machine out of the ace account it is on. */
export function machineSignOutQuestion(): SignOutQuestion {
  return {
    title: "Sign this computer out?",
    body: "Your other devices can't open it until it signs back in.",
    confirm: "Sign out",
  };
}
