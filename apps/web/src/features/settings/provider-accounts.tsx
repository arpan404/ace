import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { AccountLabelEditor } from "./account-label-editor.tsx";
import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { accountStatus, type AccountView } from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useLocation } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { CompactWindow, formatResets } from "@/features/accounts/index.ts";
import { accountLimit } from "@ace/ui-core";
import { StatusLine } from "@/components/provider-tile.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useNow } from "@/lib/time.ts";
import { useAccountViews } from "@/features/accounts/index.ts";
import { preloadSignIn, useInlineSignIn, useSignIn } from "@/features/sign-in/index.ts";
import { AddAccountButton, AccountKeyMark } from "@/features/account-management/index.ts";
import {
  apiKeyUpstreamLabel,
  canAddAccounts,
  useAccountActions,
  useApiKeySupport,
} from "@/features/account-management/index.ts";

/*
 * Every account of a provider in one list: who it is, how it signs in, which one new threads
 * use, where it stands and how much of its plan is left. Each has its own Sign in again, Make
 * default, Edit label and Remove; Add account names one and starts its sign-in straight away.
 */

export function ProviderAccounts(props: {
  provider: ProviderKind;
  name: string;
  acpAgentId?: string | undefined;
}) {
  const accounts = useAccountViews();
  const own = (accounts.data ?? []).filter(
    (account) =>
      account.provider === props.provider &&
      (props.provider !== "acp" || account.acpAgentId === props.acpAgentId),
  );
  const manageable = canAddAccounts(props.provider);
  if (!own.length && !manageable && !accounts.isPending && !accounts.isError) return null;
  return (
    <SettingSection
      label="Accounts"
      actions={<span className="text-xs text-subtle-foreground">New threads use the default</span>}
    >
      {accounts.isError && (
        <p role="alert" className="text-sm text-status-failed">
          {describeDaemonError(daemonErrorCode(accounts.error))}{" "}
          <Button size="sm" variant="ghost" onClick={() => void accounts.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {accounts.isPending ? <ListSkeleton label="accounts" shape="row" rows={3} /> : null}
      {!accounts.isPending && !accounts.isError && !own.length && (
        <p className="py-2 text-sm text-muted-foreground">No accounts yet. Add an account below.</p>
      )}
      <ul aria-label={`${props.name} accounts`}>
        {own.map((account) => (
          <AccountItem
            key={account.id}
            account={account}
            provider={props.provider}
            name={props.name}
            manageable={manageable}
          />
        ))}
        {manageable && (
          <li>
            <AddAccountButton provider={props.provider} label="+ Add account" />
          </li>
        )}
      </ul>
    </SettingSection>
  );
}

function AccountItem(props: {
  account: AccountView;
  provider: ProviderKind;
  name: string;
  manageable: boolean;
}) {
  const { account } = props;
  const highlighted =
    useLocation({ select: (location) => location.hash }) === `account-${account.id}`;
  const now = useNow();
  const signIn = useSignIn();
  const keyLogin = useInlineSignIn();
  const actions = useAccountActions();
  const toast = useToast();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Keep the casing entered by the person.
  const label = account.label;

  const state = accountStatus(account, now);
  const fail = (title: string) => (error: unknown) =>
    toast.error({ title, description: error instanceof Error ? error.message : undefined });
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const native = canAddAccounts(provider) ? provider : undefined;
  const needsSignIn =
    state.text === "Signed out" ||
    state.text === "Not signed in yet" ||
    (state.text !== "Limit reached" && !state.canRun && !account.quota.blockers.homeUnavailable);
  const showDefault = !needsSignIn && !account.isDefault && native !== undefined;
  const makeDefault = () => {
    if (native)
      void actions.setDefault(native, account.id).catch(fail(`Couldn't make ${label} the default`));
  };
  return (
    <li
      id={`account-${account.id}`}
      tabIndex={-1}
      style={highlighted ? { background: "var(--accent)" } : undefined}
      className="group rounded-md focus-ring hover:bg-accent"
    >
      <div className="flex min-h-9 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <AccountBadge account={account} tooltip={false} />
            <Tip label={label}>
              <span tabIndex={0} className="truncate rounded-xs font-medium focus-ring">
                {label}
              </span>
            </Tip>
            <AccountKeyMark method={account.authMethod} />
            {account.isDefault && (
              <span className="shrink-0 text-xs text-muted-foreground">Default</span>
            )}
          </span>
          {account.implicit && account.cliHome && (
            <span
              className="max-w-full truncate pl-7 text-xs text-subtle-foreground sm:pl-0"
              title={account.cliHome}
            >
              {account.cliHome}
            </span>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 ml-auto">
          <span className="relative inline-flex items-center">
            <span className={showDefault ? "inline-flex account-reading" : "inline-flex"}>
              {state.canRun && account.windows[0] ? (
                <CompactWindow
                  window={
                    account.windows.find((window) => window.label === "5-hour") ??
                    account.windows[0]
                  }
                  now={now}
                />
              ) : (
                <StatusLine
                  tone={state.tone}
                  text={
                    state.text === "Limit reached" &&
                    accountLimit(account, now).resetsAt !== undefined
                      ? `Limit reached · ${formatResets(accountLimit(account, now).resetsAt ?? now, now).toLowerCase()}`
                      : state.text
                  }
                />
              )}
            </span>
            {showDefault && (
              <Button
                size="sm"
                variant="ghost"
                className="absolute right-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
                onClick={makeDefault}
              >
                Make default
              </Button>
            )}
          </span>
          {signIn && props.manageable && needsSignIn ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                signIn({ provider, ...(account.implicit ? {} : { instance: account.id }) })
              }
            >
              {state.text === "Signed out" || state.text === "Not signed in yet"
                ? "Sign in"
                : "Reconnect"}
            </Button>
          ) : null}
          {signIn && props.manageable ? (
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    ref={menuTrigger}
                    icon={DotsThreeIcon}
                    label={`Manage ${label}`}
                    size="sm"
                    className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
                    onPointerEnter={() => void preloadSignIn()}
                  />
                }
              />
              <MenuContent align="end" finalFocus={renaming ? false : undefined}>
                {needsSignIn && !account.isDefault && native && (
                  <MenuItem onClick={makeDefault}>Make default</MenuItem>
                )}
                <MenuItem
                  onClick={() =>
                    signIn({ provider, ...(account.implicit ? {} : { instance: account.id }) })
                  }
                >
                  Sign in again
                </MenuItem>
                {support.data?.supported &&
                  (provider === "opencode" ? (
                    (support.data.upstreams ?? []).flatMap((upstream) => {
                      const parsed = ApiKeyUpstream.safeParse(upstream);
                      return parsed.success
                        ? [
                            <MenuItem
                              key={upstream}
                              onClick={() =>
                                keyLogin.start({
                                  provider,
                                  ...(account.implicit ? {} : { instance: account.id }),
                                  method: "api_key",
                                  upstream: parsed.data,
                                })
                              }
                            >
                              Use {apiKeyUpstreamLabel(parsed.data)} API key
                            </MenuItem>,
                          ]
                        : [];
                    })
                  ) : (
                    <MenuItem
                      onClick={() =>
                        keyLogin.start({
                          provider,
                          ...(account.implicit ? {} : { instance: account.id }),
                          method: "api_key",
                        })
                      }
                    >
                      Use API key
                    </MenuItem>
                  ))}
                <MenuItem
                  onClick={() =>
                    signIn({
                      provider,
                      action: "logout",
                      ...(account.implicit ? {} : { instance: account.id }),
                    })
                  }
                >
                  Sign out
                </MenuItem>
                <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
                <MenuItem onClick={() => setRenaming(true)}>Change badge</MenuItem>
                {!account.implicit && (
                  <>
                    <MenuSeparator />
                    <MenuItem className="text-destructive" onClick={() => setRemoving(true)}>
                      Remove
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )}
        </div>
      </div>
      {renaming && (
        <AccountLabelEditor
          account={account}
          returnFocus={menuTrigger}
          onCancel={() => setRenaming(false)}
          onSave={async (name, badge) => {
            await actions.rename(account.id, name, badge);
            setRenaming(false);
          }}
        />
      )}
      {keyLogin.content}
      <RemoveAccount
        open={removing}
        label={account.label}
        provider={provider}
        apiKey={account.authMethod === "api_key"}
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          if (native)
            actions.remove(native, account.id).catch(fail(`Couldn't remove ${account.label}`));
        }}
      />
    </li>
  );
}

function RemoveAccount(props: {
  open: boolean;
  label: string;
  provider: ProviderKind;
  apiKey: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {props.label}?</DialogTitle>
          <DialogDescription>
            {props.apiKey ? "ace never stored your API key. " : ""}
            {["codex", "claude", "cursor"].includes(props.provider)
              ? `This removes the account from ace and ${props.apiKey ? "the CLI's stored key" : "its stored sign-in"}. Sign in again to add it back.`
              : `This removes the account from ace. ${props.apiKey ? "The key stays in the CLI's credential store" : "Its sign-in stays with the CLI"}; remove it through the CLI if needed.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={props.onConfirm}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
