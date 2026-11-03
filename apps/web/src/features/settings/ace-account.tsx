import { useEffect, useRef, useState } from "react";
import { AceAccountError } from "@ace/client/ace-account";
import type { AceLogin } from "@ace/protocol/ace-account";
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

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

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
  const { session, restoring, error: accountError } = useAceAccount();
  const [login, setLogin] = useState<AceLogin>();
  const [busy, setBusy] = useState(false);
  const [loginError, setError] = useState("");
  const search: Record<string, unknown> = useSearch({ strict: false });
  const [returnSeen, setReturnSeen] = useState(false);
  const returnNote =
    !returnSeen && typeof search.signin === "string" ? returned[search.signin] : undefined;
  const error = (!session && returnNote) || loginError || accountError;
  const [openBlocked, setOpenBlocked] = useState(false);
  const work = useRef<AbortController | undefined>(undefined);
  const pending = useRef<AceLogin | undefined>(undefined);

  useEffect(
    () => () => {
      work.current?.abort();
      if (client && pending.current)
        void client.cancel(pending.current, AbortSignal.timeout(5000)).catch(() => {});
    },
    [client],
  );

  async function signIn() {
    if (!store || !client || busy || restoring) return;
    const controller = new AbortController();
    work.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    setBusy(true);
    setError("");
    setReturnSeen(true);
    store.report("");
    setOpenBlocked(false);
    try {
      const request = client.login(
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        store.returnTo ? { returnTo: store.returnTo } : {},
      );
      // Reserve the browser tab during the click, before awaiting the login request.
      void openExternalWhenReady(request.then((next) => next.loginUrl)).catch(() => {
        if (!signal.aborted) setOpenBlocked(true);
      });
      const next = await request;
      pending.current = next;
      if (signal.aborted) {
        await client.cancel(next, AbortSignal.timeout(5000));
        return;
      }
      setLogin(next);
      for (;;) {
        await pause(signal);
        if (signal.aborted) return;
        const result = await client
          .poll(next, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
          .catch((cause: unknown) => {
            if (cause instanceof AceAccountError && [401, 410].includes(cause.status)) throw cause;
            if (!signal.aborted) setError("Connection interrupted. Retrying sign-in…");
            return undefined;
          });
        if (!result) continue;
        if (result.status === "pending") continue;
        if (signal.aborted) return;
        pending.current = undefined;
        setError("");
        await store.signedIn(result.session);
        return;
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      // The backend lets a sign-in wait ten minutes, then forgets it (410).
      if (cause instanceof AceAccountError && cause.status === 410) {
        pending.current = undefined;
        setError("Sign-in took too long. Try again.");
      } else setError("Couldn't sign in. Try again.");
    } finally {
      if (work.current === controller) {
        if (pending.current)
          void client.cancel(pending.current, AbortSignal.timeout(5000)).catch(() => {});
        pending.current = undefined;
        setBusy(false);
        setLogin(undefined);
      }
    }
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
              {login && openBlocked && (
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
        ) : busy ? (
          <Button variant="ghost" onClick={() => work.current?.abort()}>
            Cancel
          </Button>
        ) : (
          <Button disabled={!client || busy || restoring} onClick={() => void signIn()}>
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
