import { ApiKeyUpstream, type ProviderKind } from "@ace/protocol";
import { accountStatus, type AccountView } from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useNow } from "@/lib/time.ts";
import { useAccountViews, WindowBar } from "@/features/accounts/index.ts";
import { preloadSignIn, useInlineSignIn, useSignIn } from "@/features/sign-in/index.ts";
import { AddAccount } from "./add-provider-account.tsx";
import {
  apiKeyUpstreamLabel,
  canAddAccounts,
  useAccountActions,
  useApiKeySupport,
} from "./account-actions.ts";

/*
 * Every account of a provider in one list: who it is, how it signs in, which one new threads
 * use, where it stands and how much of its plan is left. Each has its own Sign in again, Make
 * default, Rename and Remove; Add account names one and starts its sign-in straight away.
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
        {manageable && <AddAccount provider={props.provider} name={props.name} />}
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
  // The CLI's own sign-in is named by who it is signed in as, when the CLI says.
  const label = account.label;

  const state = accountStatus(account, now);
  const fail = (title: string) => (error: unknown) =>
    toast.error({ title, description: error instanceof Error ? error.message : undefined });
  const provider = props.provider;
  const support = useApiKeySupport(provider);
  const native = canAddAccounts(provider) ? provider : undefined;
  return (
    <li className="py-1">
      <div className="flex min-h-8 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {renaming ? (
            <RenameField
              label={account.label}
              onCancel={() => setRenaming(false)}
              onSave={(next) => {
                setRenaming(false);
                if (next !== account.label)
                  actions.rename(account.id, next).catch(fail(`Couldn't rename ${account.label}`));
              }}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{label}</span>
              {account.isDefault && !props.only && (
                <span className="shrink-0 text-xs text-muted-foreground">Default</span>
              )}
            </span>
          )}
        </div>
        <StatusLine tone={state.tone} text={state.text} />
        {signIn && props.manageable && (
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
                  <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
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
      {account.windows.length > 0 && (
        <div className="grid gap-x-6 gap-y-2 py-2 text-sm sm:grid-cols-2">
          {account.windows.map((window) => (
            <WindowBar key={window.id} window={window} now={now} />
          ))}
        </div>
      )}
      <RemoveAccount
        open={removing}
        label={account.label}
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          actions.remove(account.id).catch(fail(`Couldn't remove ${account.label}`));
        }}
      />
    </li>
  );
}

function RenameField(props: { label: string; onSave(label: string): void; onCancel(): void }) {
  const [value, setValue] = useState(props.label);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (next) props.onSave(next);
    else props.onCancel();
  };
  return (
    <form aria-label="Rename account" onSubmit={save} className="flex items-center gap-1.5">
      <Input
        aria-label="Account name"
        autoFocus
        value={value}
        maxLength={128}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
        }}
        className="h-7 max-w-64"
      />
      <Button type="submit" size="sm" variant="primary">
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function RemoveAccount(props: {
  open: boolean;
  label: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {props.label}?</DialogTitle>
          <DialogDescription>
            ace stops using this account. Its sign-in stays on this computer, so adding it again is
            quick.
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
