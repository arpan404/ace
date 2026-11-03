import { useState } from "react";
import { initials } from "@ace/ui-core";
import { UserIcon } from "@phosphor-icons/react";
import { useSearch } from "@tanstack/react-router";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { useAceAccount, useAceAccountStore } from "@/features/ace-account/index.ts";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Icon } from "@/components/icon.tsx";
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

/** Optional ace identity. Local operation and machine pairing do not depend on this session. */
export function AceAccountSettings() {
  const [name, setName] = useProfileName();
  const [draftName, setDraftName] = useState(name);
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
    <SettingSection label="Profile" card scope="device">
      <SettingRow
        id="account.signIn"
        inline
        title={
          <div className="flex min-w-0 items-center gap-3 py-2">
            <span
              aria-hidden
              className="grid size-12 shrink-0 place-items-center rounded-full border border-border bg-secondary text-base font-medium text-foreground"
            >
              {initials(session?.account.name || name) || <Icon icon={UserIcon} size={20} />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium">
                {session?.account.name || name.trim() || "Your profile"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {session?.account.email ||
                  (login ? "Complete sign-in in your browser" : "Not signed in")}
              </span>
              {login && signIn?.openBlocked && (
                <button
                  type="button"
                  className="w-fit rounded-sm text-xs text-foreground underline underline-offset-2 focus-ring"
                  onClick={() =>
                    void openExternal(login.loginUrl).catch(() =>
                      setError("Couldn't open your browser. Try again."),
                    )
                  }
                >
                  Open browser
                </button>
              )}
            </div>
          </div>
        }
      >
        {session ? (
          <Button disabled={busy || restoring} onClick={() => void signOut()}>
            Sign out
          </Button>
        ) : signIn ? (
          <Button variant="ghost" onClick={() => store?.cancelSignIn()}>
            Cancel
          </Button>
        ) : (
          <Button disabled={!client || restoring} onClick={startSignIn}>
            {restoring ? "Connecting…" : "Sign in"}
          </Button>
        )}
      </SettingRow>
      <SettingRow {...settingRow("profile.name")} htmlFor="profile-name">
        <Input
          id="profile-name"
          className="@[30rem]:w-52"
          value={draftName}
          placeholder="Name"
          autoComplete="name"
          maxLength={80}
          onChange={(event) => setDraftName(event.currentTarget.value)}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            setDraftName(next);
            setName(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const next = event.currentTarget.value.trim();
              setDraftName(next);
              setName(next);
            }
          }}
        />
      </SettingRow>
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}
