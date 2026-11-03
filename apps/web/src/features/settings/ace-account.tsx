import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { useAceAccount, useAceAccountStore } from "@/features/ace-account/index.ts";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ProfileAvatar } from "@/components/profile-avatar.tsx";
import { useProfileName } from "@/lib/profile.ts";
import { settingRow } from "./settings-index.ts";

/**
 * What the desktop app's `ace://account/signed-in` link said about a sign-in that didn't
 * finish (`?signin=` on this page). A finished one shows as the account itself.
 */
const returned: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  failed: "Couldn't sign in. Try again.",
  expired: "That sign-in expired or was already used. Try again.",
};

/**
 * The top of Profile: who the person is and their ace account. Signed out, one sentence on what
 * an account adds and Sign in; signing in, where to finish and how to stop; signed in, the
 * account's name and email with Sign out. ace works without an account.
 */
export function ProfileIdentity() {
  const [name] = useProfileName();
  const store = useAceAccountStore();
  const client = store?.client;
  const { session, restoring, error: accountError, signIn } = useAceAccount();
  const login = signIn?.login;
  const [busy, setBusy] = useState(false);
  const [loginError, setError] = useState("");
  const search: Record<string, unknown> = useSearch({ strict: false });
  const [returnSeen, setReturnSeen] = useState(false);
  const returnNote =
    !returnSeen && typeof search.signin === "string" ? returned[search.signin] : undefined;
  const error = (!session && returnNote) || loginError || accountError;
  const shown = session?.account.name || name.trim();

  function startSignIn() {
    if (!store || !client || signIn || restoring) return;
    setError("");
    setReturnSeen(true);
    // The window's sign-in, not this page's: it keeps going if the person leaves Settings.
    store.signIn((address) => openExternalWhenReady(address));
  }

  async function signOut() {
    if (!store || !session || busy || restoring) return;
    setBusy(true);
    setError("");
    try {
      await store.signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="account.signIn" aria-label="ace account" className="mb-8 scroll-mt-32">
      <div className="flex min-w-0 items-center gap-4">
        <ProfileAvatar name={shown} className="size-14 text-lg" iconSize={20} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-lg leading-6 font-semibold tracking-[-0.01em]">
            {shown || "Your profile"}
          </span>
          <span className="truncate text-ui text-muted-foreground">
            {session?.account.email ||
              (signIn ? "Finishing sign-in in your browser" : "Not signed in")}
          </span>
        </div>
        {session && (
          <Button variant="ghost" disabled={busy || restoring} onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </div>
      {!session && (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
          <p className="min-w-56 flex-1 text-ui leading-normal text-muted-foreground">
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
                      setError("Couldn't open your browser. Try again."),
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
            <Button variant="primary" disabled={!client || restoring} onClick={startSignIn}>
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

/** The name ace shows beside the person's messages, kept on this device. */
export function ProfileNameSettings() {
  const [name, setName] = useProfileName();
  const [draftName, setDraftName] = useState(name);
  const save = (value: string) => {
    const next = value.trim();
    setDraftName(next);
    setName(next);
  };
  return (
    <SettingSection label="You" card scope="device">
      <SettingRow {...settingRow("profile.name")} htmlFor="profile-name">
        <Input
          id="profile-name"
          className="@[30rem]:w-52"
          value={draftName}
          placeholder="Name"
          autoComplete="name"
          maxLength={80}
          onChange={(event) => setDraftName(event.currentTarget.value)}
          onBlur={(event) => save(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save(event.currentTarget.value);
          }}
        />
      </SettingRow>
    </SettingSection>
  );
}
