import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { AccountLabelEditor } from "./account-label-editor.tsx";
import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import {
  accountStatus,
  antigravityIdentity,
  headlineWindows,
  type AccountView,
} from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { CompactWindow, formatResets } from "@/features/accounts/index.ts";
import { accountLimit } from "@ace/ui-core";
import { StatusLine } from "@/components/provider-tile.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingSection,
} from "@/components/setting-row.tsx";
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
import { AddAccountRow, AccountKeyMark } from "@/features/account-management/index.ts";
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

/**
 * Whether an account is this provider page's. ace runs Antigravity through its ACP agent, so
 * Antigravity's account is the ACP row of its own CLI login, never another installation of the
 * same agent (its actions sign that CLI login in and out).
 */
function ownAccount(account: AccountView, provider: ProviderKind, acpAgentId?: string): boolean {
  if (provider === "antigravity")
    return account.provider === "acp" && account.id === antigravityIdentity.instanceId;
  return account.provider === provider && (provider !== "acp" || account.acpAgentId === acpAgentId);
}

/** Agents reached over ACP keep one sign-in of their own: ace signs it in and out, never adds. */
const agentProvider = (provider: ProviderKind) => provider === "acp" || provider === "antigravity";

export function ProviderAccounts(props: {
  provider: ProviderKind;
  name: string;
  acpAgentId?: string | undefined;
}) {
  const accounts = useAccountViews();
  const own = (accounts.data ?? []).filter((account) =>
    ownAccount(account, props.provider, props.acpAgentId),
  );
  const addable = canAddAccounts(props.provider);
  const manageable = addable || agentProvider(props.provider);
  if (!own.length && !addable && !accounts.isPending && !accounts.isError) return null;
  return (
    <SettingSection
      label="Accounts"
      actions={<span className="text-xs text-subtle-foreground">New threads use the default</span>}
    >
      {accounts.isError && (
        <SettingNote role="alert" className="text-status-failed">
          {describeDaemonError(daemonErrorCode(accounts.error))}{" "}
          <Button size="sm" variant="ghost" onClick={() => void accounts.refetch()}>
            Retry
          </Button>
        </SettingNote>
      )}
      {accounts.isPending ? <ListSkeleton label="accounts" shape="row" rows={3} /> : null}
      {!accounts.isPending && !accounts.isError && !own.length && addable && (
        <SettingNote>No accounts yet. Add an account below.</SettingNote>
      )}
      <SettingList aria-label={`${props.name} accounts`}>
        {own.map((account) => (
          <AccountItem
            key={account.id}
            account={account}
            provider={props.provider}
            name={props.name}
            manageable={manageable}
          />
        ))}
        {addable && (
          <li>
            <AddAccountRow provider={props.provider} />
          </li>
        )}
      </SettingList>
      {!addable && own.length > 0 && (
        <SettingNote>
          {props.name} keeps one sign-in on this computer. Sign in again to switch accounts.
        </SettingNote>
      )}
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
  // Antigravity signs in through its own CLI login; any other account is named. The dialog
  // names the agent, not "ACP agent".
  const target = {
    ...(agentProvider(provider) ? { name: props.name } : {}),
    ...(provider === "antigravity" || account.implicit ? {} : { instance: account.id }),
  };
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
    // A new account's link (#account-<id>) scrolls to its row and flashes it.
    <SettingListItem
      id={`account-${account.id}`}
      tabIndex={-1}
      className="group focus-ring-inset hover:bg-accent"
    >
      <div className="flex min-h-9 min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <AccountBadge account={account} tooltip={false} />
            <Tip label={label}>
              {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
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
          {/* The reading always shows; Make default sits beside it, never in its place. */}
          {showDefault && (
            <Button size="sm" variant="ghost" onClick={makeDefault}>
              Make default
            </Button>
          )}
          <span className="inline-flex items-center">
            {state.canRun && account.windows[0] ? (
              <span className="flex flex-col items-end gap-1">
                {headlineWindows(account.windows).map((window) => (
                  <CompactWindow key={window.id} window={window} now={now} />
                ))}
              </span>
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
          {signIn && props.manageable && needsSignIn ? (
            <Button size="sm" variant="secondary" onClick={() => signIn({ provider, ...target })}>
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
                <MenuItem onClick={() => signIn({ provider, ...target })}>Sign in again</MenuItem>
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
                <MenuItem onClick={() => signIn({ provider, action: "logout", ...target })}>
                  Sign out
                </MenuItem>
                <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
                <MenuItem onClick={() => setRenaming(true)}>Change badge</MenuItem>
                {!account.implicit && native && (
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
    </SettingListItem>
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
