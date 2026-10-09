import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { AccountLabelEditor } from "./account-label-editor.tsx";
import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { accountStatus, type AccountView } from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { StatusLine } from "@/components/provider-tile.tsx";
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
import { useNow } from "@/lib/time.ts";
import { useAccountViews } from "@/features/accounts/index.ts";
import { preloadSignIn, useInlineSignIn, useSignIn } from "@/features/sign-in/index.ts";
import { AddAccountInline, AccountKeyMark } from "@/features/account-management/index.ts";
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
  if (!own.length && !manageable) return null;
  return (
    <SettingSection label="Accounts">
      <ul aria-label={`${props.name} accounts`} className="divide-y">
        {own.map((account) => (
          <AccountItem
            key={account.id}
            account={account}
            provider={props.provider}
            name={props.name}
            manageable={manageable}
            only={own.length === 1}
          />
        ))}
        {manageable && (
          <li>
            <AddAccountInline provider={props.provider} />
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
  /** The provider's only account: no point saying which is the default. */
  only: boolean;
}) {
  const { account } = props;
  const now = useNow();
  const signIn = useSignIn();
  const keyLogin = useInlineSignIn();
  const actions = useAccountActions();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Named accounts keep the casing entered by the person.
  const label = account.label;

  const state = accountStatus(account, now);
  const fail = (title: string) => (error: unknown) =>
    toast.error({ title, description: error instanceof Error ? error.message : undefined });
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const native = canAddAccounts(provider) ? provider : undefined;
  return (
    <li className="py-0.5">
      <div className="flex min-h-8 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {renaming ? (
            <AccountLabelEditor
              account={account}
              onCancel={() => setRenaming(false)}
              onSave={(name, badge) => {
                actions
                  .rename(account.id, name, badge)
                  .then(() => setRenaming(false))
                  .catch(fail(`Couldn't update ${account.label}`));
              }}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderAccountIcon provider={provider} account={account} size={16} />
              <span className="truncate font-medium">{label}</span>
              <AccountKeyMark method={account.authMethod} />
              {account.isDefault && !props.only && (
                <span className="shrink-0 text-xs text-muted-foreground">Default</span>
              )}
            </span>
          )}
        </div>
        {!renaming && <StatusLine tone={state.tone} text={state.text} />}
        {!renaming && signIn && props.manageable && (
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  icon={DotsThreeIcon}
                  label={`Manage ${label}`}
                  size="sm"
                  onPointerEnter={() => void preloadSignIn()}
                />
              }
            />
            <MenuContent align="end">
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
              {!account.isDefault && native && (
                <MenuItem
                  onClick={() =>
                    actions
                      .setDefault(native, account.id)
                      .catch(fail(`Couldn't make ${label} the default`))
                  }
                >
                  Make default
                </MenuItem>
              )}
              {!account.implicit && (
                <>
                  <MenuItem onClick={() => setRenaming(true)}>Edit label…</MenuItem>
                  <MenuSeparator />
                  <MenuItem className="text-destructive" onClick={() => setRemoving(true)}>
                    Remove
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
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
