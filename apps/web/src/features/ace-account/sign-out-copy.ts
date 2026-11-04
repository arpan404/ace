/*
 * What signing out asks before it happens. Signing out never deletes anything: threads, drafts
 * and queued messages stay where they are and come back on the next sign-in, so each question
 * says what stops and what stays.
 */

export interface SignOutQuestion {
  title: string;
  body: string;
  confirm: string;
}

/** Signing this app out of the person's ace account. `desktop`: this computer can leave with it. */
export function accountSignOutQuestion(input: {
  email: string | undefined;
  desktop: boolean;
}): SignOutQuestion {
  return {
    title: input.email ? `Sign out of ${input.email}?` : "Sign out of your ace account?",
    body: [
      "This app stops opening the machines on your account until you sign in again.",
      "Your threads, drafts and anything waiting to send stay here.",
      input.desktop ? "If this computer joined your account through this app, it leaves too." : "",
    ]
      .filter(Boolean)
      .join(" "),
    confirm: "Sign out",
  };
}

/** Signing a machine out of the ace account it is on. */
export function machineSignOutQuestion(input: { email: string | undefined }): SignOutQuestion {
  return {
    title: input.email
      ? `Sign this computer out of ${input.email}?`
      : "Sign this computer out of its ace account?",
    body: "Your other devices can't open it through your ace account until it signs in again. Its threads and data stay on it.",
    confirm: "Sign out",
  };
}
