import { addressHost } from "@ace/ui-core";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { BrowserView } from "../sources.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

/**
 * A site asks for a sign-in (HTTP authentication) before it shows the page. Only the person
 * answers it; agents wait. What is typed goes to the page's browser for this request and is
 * never kept by ace. The prompt of the shown tab comes first, then any other tab's.
 */
export function PageSignIn(props: {
  view: BrowserView;
  browser: Pick<BrowserFeatures, "answerAuth">;
}) {
  const tabs = props.view.tabs ?? [];
  const tab =
    tabs.find((each) => each.tabId === props.view.activeTabId && each.pendingAuth) ??
    tabs.find((each) => each.pendingAuth);
  const challenge = tab?.pendingAuth;
  const [sent, setSent] = useState<string>();
  if (!tab || !challenge) return null;
  const site = addressHost(challenge.origin) ?? challenge.origin;
  const sending = sent === challenge.authId;
  const answer = (credentials?: { username: string; password: string }) => {
    if (sending) return;
    setSent(challenge.authId);
    void props.browser.answerAuth(tab.tabId, challenge.authId, credentials).then((result) => {
      if (result === undefined)
        setSent((current) => (current === challenge.authId ? undefined : current));
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    answer({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  };
  return (
    <form
      key={challenge.authId}
      role="dialog"
      aria-label={`Sign in to ${site}`}
      onSubmit={submit}
      className="flex shrink-0 flex-col gap-2 border-b bg-foreground/3 px-3 py-2.5"
    >
      <p className="flex items-start gap-2 text-sm">
        <LockSimpleIcon aria-hidden size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-muted-foreground">
          {site}
          {props.view.activeTabId && tab.tabId !== props.view.activeTabId && " (another tab)"}
          {" asks you to sign in"}
          {challenge.realm && <span className="text-foreground">{` to “${challenge.realm}”`}</span>}
        </span>
      </p>
      <div className="flex gap-2">
        <Input
          name="username"
          aria-label="Username"
          autoComplete="username"
          disabled={sending}
          autoFocus
        />
        <Input
          name="password"
          type="password"
          aria-label="Password"
          autoComplete="current-password"
          disabled={sending}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <span className="min-w-0 flex-1 text-xs text-subtle-foreground">
          Goes only to this site; ace doesn't keep it. Agents wait for you.
        </span>
        <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={() => answer()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="secondary" disabled={sending}>
          Sign in
        </Button>
      </div>
    </form>
  );
}
