import { AccountBadge } from "@/components/ui/provider-account-icon.tsx";
import { AccountLabelEditor } from "./account-label-editor.tsx";
import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import {
  accountStatus,
  antigravitySignInLabel,
  headlineWindows,
  providerAccountViews,
  type AccountView,
} from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { formatResets } from "@/features/accounts/index.ts";
import { accountLimit } from "@ace/ui-core";
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
import { cn } from "@/lib/cn.ts";
import { AccountWindows } from "./account-windows.tsx";
import { accountFix, accountSignInTarget, agentProvider } from "./provider-problem.ts";
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
 * Every account of a provider on one rounded group: who it is, which one new threads use, where
 * it stands and how much of its plan is left, its one fix, and a menu with everything else
 * (Sign in again, Rename, Change badge, Make default, Log out, Remove account). Add account
 * names one and starts its sign-in straight away.
 */

export function ProviderAccounts(props: {
  provider: ProviderKind;
  name: string;
  acpAgentId?: string | undefined;
}) {
  const accounts = useAccountViews();
  const own = providerAccountViews(accounts.data ?? [], props.provider, props.acpAgentId);
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

/** A status in its tone's colour, words only: an account's sub line. */
const toneOf = { ready: "done", action: "needs-you", problem: "failed", idle: "idle" } as const;

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
  const target = accountSignInTarget(account, provider, props.name);
  // Accounts ace added can be removed; a CLI's or agent's own login can't.
  const removable = native !== undefined && !account.implicit && account.acpHome !== "default_cli";
  const fix = accountFix(account, state);
  const showDefault = !fix && !account.isDefault && native !== undefined;
  const makeDefault = () => {
    if (native)
      void actions.setDefault(native, account.id).catch(fail(`Couldn't make ${label} the default`));
  };
  const windows = state.canRun && account.windows[0] ? headlineWindows(account.windows) : [];
  const limit = state.text === "Limit reached" ? accountLimit(account, now).resetsAt : undefined;
  // The state in words when it matters, or when no usage stands for it.
  const words =
    state.tone !== "ready" || !windows.length
      ? limit !== undefined
        ? `Limit reached · ${formatResets(limit, now).toLowerCase()}`
        : state.text
      : undefined;
  const home = account.implicit ? account.cliHome : undefined;
  return (
    // A new account's link (#account-<id>) scrolls to its row and flashes it.
    <SettingListItem
      id={`account-${account.id}`}
      tabIndex={-1}
      className="flex-wrap gap-x-3 gap-y-2 py-2 focus-ring-inset"
    >
      <AccountBadge account={account} tooltip={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Tip label={label}>
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so its tooltip reaches the keyboard */}
            <span tabIndex={0} className="truncate rounded-xs font-medium focus-ring">
              {label}
            </span>
          </Tip>
          <AccountKeyMark method={account.authMethod} />
          {account.isDefault && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 text-xs leading-[18px] font-medium text-muted-foreground">
              Default
            </span>
          )}
          {account.antigravitySignIn && (
            <span className="shrink-0 text-xs text-subtle-foreground">
              {antigravitySignInLabel(account.antigravitySignIn)}
            </span>
          )}
        </span>
        {(words || home) && (
          <span className="flex min-w-0 items-baseline gap-1 text-xs text-subtle-foreground">
            {words && (
              <span
                data-tone={toneOf[state.tone]}
                className={cn("shrink-0", state.tone !== "ready" && "text-(--tone-text)")}
              >
                {words}
              </span>
            )}
            {words && home && <span aria-hidden>·</span>}
            {home && (
              <span className="min-w-0 truncate" title={home}>
                {home}
              </span>
            )}
          </span>
        )}
      </div>
      {/* On a narrow screen the usage and actions wrap under the name. */}
      <div className="ml-auto flex items-center justify-end gap-2 @max-[34rem]:w-full @max-[34rem]:pl-8">
        {windows.length > 0 && <AccountWindows windows={windows} now={now} />}
        {signIn && props.manageable && fix ? (
          <Button size="sm" variant="secondary" onClick={() => signIn(target)}>
            {fix === "sign_in" ? "Sign in" : "Reconnect"}
          </Button>
        ) : null}
        {showDefault && (
          <Button size="sm" variant="ghost" onClick={makeDefault}>
            Make default
          </Button>
        )}
        {signIn && props.manageable ? (
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  ref={menuTrigger}
                  icon={DotsThreeIcon}
                  label={`Manage ${label}`}
                  size="sm"
                  onPointerEnter={() => void preloadSignIn()}
                />
              }
            />
            <MenuContent align="end" finalFocus={renaming ? false : undefined}>
              <MenuItem onClick={() => signIn(target)}>Sign in again</MenuItem>
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
              <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
              <MenuItem onClick={() => setRenaming(true)}>Change badge</MenuItem>
              {!account.isDefault && native && (
                <MenuItem onClick={makeDefault}>Make default</MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={() => signIn({ ...target, action: "logout" })}>Log out</MenuItem>
              {removable && (
                <MenuItem danger onClick={() => setRemoving(true)}>
                  Remove account…
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
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
        name={props.name}
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
  /** The provider's name, for the title. */
  name: string;
  provider: ProviderKind;
  apiKey: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Remove {props.label} from {props.name}?
          </DialogTitle>
          <DialogDescription>
            {props.apiKey ? "ace never stored your API key. " : ""}
            {["codex", "claude", "cursor", "antigravity"].includes(props.provider)
              ? `This removes the account from ace and ${props.apiKey ? "the CLI's stored key" : "its stored sign-in"}. Sign in again to add it back.`
              : `This removes the account from ace. ${props.apiKey ? "The key stays in the CLI's credential store" : "Its sign-in stays with the CLI"}; remove it through the CLI if needed.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={props.onConfirm}>
            Remove account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
