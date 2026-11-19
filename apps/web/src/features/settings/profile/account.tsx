import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { SettingNote, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  useAccountPicture,
  useAceAccount,
  useAceAccountStore,
} from "@/features/ace-account/index.ts";
import { useProfileName } from "@/lib/profile.ts";
import { SignOutButton } from "./sign-out-button.tsx";

/**
 * What the desktop app's `ace://account/signed-in` link said about a sign-in that didn't
 * finish (`?signin=` on this page). A finished one shows as the account itself.
 */
const returned: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  failed: "Couldn't sign in. Try again.",
  expired: "That sign-in expired or was already used. Try again.",
};

/** The person's ace account on Profile: signing in, out, and what went wrong. */
export function useProfileAccount() {
  const [name] = useProfileName();
  const store = useAceAccountStore();
  const { session, restoring, error: accountError, signIn } = useAceAccount();
  const [busy, setBusy] = useState(false);
  const [localError, setError] = useState("");
  const search: Record<string, unknown> = useSearch({ strict: false });
  const [returnSeen, setReturnSeen] = useState(false);
  const returnNote =
    !returnSeen && typeof search.signin === "string" ? returned[search.signin] : undefined;
  return {
    store,
    session,
    restoring,
    signIn,
    busy,
    shown: session?.account.name || name.trim(),
    error: (!session && returnNote) || localError || accountError,
    setError,
    startSignIn() {
      if (!store || signIn || restoring) return;
      setError("");
      setReturnSeen(true);
      // The window's sign-in, not this page's: it keeps going if the person leaves Settings.
      store.signIn((address) => openExternalWhenReady(address));
    },
    async signOut() {
      if (!store || !session || busy || restoring) return;
      setBusy(true);
      setError("");
      try {
        await store.signOut();
      } finally {
        setBusy(false);
      }
    },
  };
}
export type ProfileAccount = ReturnType<typeof useProfileAccount>;

/**
 * Profile's first group: the person as one row (avatar, name, the account's email or its state)
 * with the account's one action at its end. Signed out, one line on what an account adds and
 * Sign in; while signing in, how to reopen the browser or stop. ace works without an account.
 */
export function PersonSection(props: { account: ProfileAccount }) {
  const { session, signIn, store, restoring, error, shown } = props.account;
  const picture = useAccountPicture();
  const login = signIn?.login;
  const line =
    session?.account.email ??
    (signIn
      ? "Finishing sign-in in your browser"
      : "Not signed in. An account opens your machines from anywhere.");
  return (
    <SettingSection label="ace account" anchor="account.signIn">
      <div
        data-setting-slot=""
        className="flex min-h-(--setting-row-height) items-center gap-3 py-3"
      >
        <ProfileAvatar name={shown} picture={picture} className="size-9 text-sm" iconSize={16} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-ui font-medium text-foreground">{shown || "You"}</p>
          <p className="truncate text-xs text-subtle-foreground">{line}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 [&>[data-variant=ghost]:last-child]:-mr-2.5">
          {session ? (
            <SignOutButton account={props.account} />
          ) : signIn ? (
            <>
              {login && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void openExternal(login.loginUrl).catch(() =>
                      props.account.setError("Couldn't open your browser. Try again."),
                    )
                  }
                >
                  {signIn.openBlocked ? "Open browser" : "Open browser again"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => store?.cancelSignIn()}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!store || restoring}
              onClick={props.account.startSignIn}
            >
              {restoring ? "Connecting…" : "Sign in"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
