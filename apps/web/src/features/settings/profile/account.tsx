import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  useAccountPicture,
  useAceAccount,
  useAceAccountStore,
} from "@/features/ace-account/index.ts";
import { useProfileName } from "@/lib/profile.ts";

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
 * The top of Profile, centred: the avatar, the name and the account's email. Signed out, one
 * sentence on what an account adds and Sign in; while signing in, where to finish and how to
 * stop. ace works without an account.
 */
export function ProfileHero(props: { account: ProfileAccount }) {
  const { session, signIn, store, restoring, error, shown } = props.account;
  const picture = useAccountPicture();
  const login = signIn?.login;
  return (
    <section
      id="account.signIn"
      aria-label="ace account"
      className="flex scroll-mt-32 flex-col items-center text-center"
    >
      <ProfileAvatar name={shown} picture={picture} className="size-24 text-3xl" iconSize={36} />
      <h2 className="mt-5 text-2xl leading-8 font-semibold tracking-[-0.015em]">
        {shown || "Your profile"}
      </h2>
      <p className="mt-1 text-base text-muted-foreground">
        {session?.account.email ?? (signIn ? "Finishing sign-in in your browser" : "Not signed in")}
      </p>
      {!session && (
        <div className="mt-5 flex max-w-md flex-col items-center gap-4">
          <p className="text-ui leading-normal text-muted-foreground">
            {signIn
              ? "Continue in your browser. This page updates when you're done."
              : "Sign in to open your machines from your phone or another computer, anywhere. Everything here works without an account."}
          </p>
          {signIn ? (
            <div className="flex items-center gap-2">
              {login && (
                <Button
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
              <Button variant="ghost" onClick={() => store?.cancelSignIn()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              disabled={!store || restoring}
              onClick={props.account.startSignIn}
            >
              {restoring ? "Connecting…" : "Sign in"}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-ui text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
