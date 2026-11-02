import { useEffect, useMemo, useRef, useState } from "react";
import { aceAccountClient, AceAccountError } from "@ace/client/ace-account";
import { AceAccountGrant, type AceLogin } from "@ace/protocol/ace-account";
import { initials, readJson, writeJson } from "@ace/ui-core";
import { UserIcon } from "@phosphor-icons/react";
import { webStorage } from "@/boot/web-storage.ts";
import { openExternal, openExternalWhenReady } from "@/boot/open-external.ts";
import { authorizeDaemonUrl } from "@/boot/daemon-network.ts";
import { accountSecret } from "@/boot/account-secret.ts";
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

/** Optional ace identity. Local operation and machine pairing do not depend on this session. */
export function AceAccountSettings() {
  const [name, setName] = useProfileName();
  const [draftName, setDraftName] = useState(name);
  const origin = import.meta.env.VITE_ACE_ACCOUNT_URL;
  const client = useMemo(
    () =>
      origin
        ? aceAccountClient({
            origin,
            fetch: async (input, init) => {
              await authorizeDaemonUrl(`${origin}/`);
              return fetch(input, init);
            },
          })
        : undefined,
    [origin],
  );
  const [secure] = useState(() => accountSecret());
  const [storage] = useState(() => webStorage(() => sessionStorage));
  const key = `ace.account.session:${origin ?? ""}`;
  const [session, setSession] = useState(() =>
    readJson(storage, key, AceAccountGrant.nullable(), null),
  );
  const [restoring, setRestoring] = useState(Boolean(client && (session || secure)));
  const [login, setLogin] = useState<AceLogin>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openBlocked, setOpenBlocked] = useState(false);
  const work = useRef<AbortController | undefined>(undefined);
  const pending = useRef<AceLogin | undefined>(undefined);

  useEffect(() => {
    if (!client || !origin) return;
    const controller = new AbortController();
    const stored = readJson(storage, key, AceAccountGrant.nullable(), null);
    void (async () => {
      const token = stored?.token ?? (await secure?.read(origin).catch(() => null));
      if (!token || controller.signal.aborted) return;
      const value = await client.session(
        token,
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (controller.signal.aborted) return;
      const next = { ...value, token };
      setSession(next);
      writeJson(storage, key, next);
    })()
      .catch(async (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof AceAccountError && cause.status === 401) {
          setSession(null);
          storage.removeItem?.(key);
          if (secure) await secure.write(origin, null).catch(() => {});
        }
        setError("Couldn't verify your account. Try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [client, storage, key, secure, origin]);

  useEffect(
    () => () => {
      work.current?.abort();
      if (client && pending.current)
        void client.cancel(pending.current, AbortSignal.timeout(5000)).catch(() => {});
    },
    [client],
  );

  async function signIn() {
    if (!client || busy || restoring) return;
    const controller = new AbortController();
    work.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    setBusy(true);
    setError("");
    setOpenBlocked(false);
    try {
      const request = client.login(AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
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
        writeJson(storage, key, result.session);
        setSession(result.session);
        if (secure && origin)
          await secure
            .write(origin, result.session.token)
            .catch(() => setError("Signed in for this window only."));
        return;
      }
    } catch {
      if (!controller.signal.aborted) setError("Couldn't sign in. Try again.");
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
    if (!client || !session || busy || restoring) return;
    setBusy(true);
    setError("");
    try {
      await client.logout(session.token, AbortSignal.timeout(15_000));
      storage.removeItem?.(key);
      setSession(null);
      if (secure && origin)
        await secure
          .write(origin, null)
          .catch(() => setError("Signed out. Couldn't clear the saved account session."));
    } catch {
      setError("Couldn't sign out. Reconnect and try again.");
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
