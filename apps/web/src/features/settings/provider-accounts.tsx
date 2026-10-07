import type { ProviderKind } from "@ace/protocol";
import type { AccountView, ReadinessTone, ReadinessView } from "@ace/ui-core";
import { DotsThreeIcon, PlusIcon } from "@phosphor-icons/react";
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
import { preloadSignIn, useSignIn } from "@/features/sign-in/index.ts";
import { canAddAccounts, useAccountActions } from "./account-actions.ts";

/*
 * Every account of a provider in one list: who it is, how it signs in, which one new threads
 * use, where it stands and how much of its plan is left. Each has its own Sign in again, Make
 * default, Rename and Remove; Add account names one and starts its sign-in straight away.
 */

function accountState(account: AccountView): { tone: ReadinessTone; text: string } {
  if (account.quota.auth === "logged_out" || account.availability === "logged_out")
    return { tone: "action", text: "Signed out" };
  if (account.quota.auth === "unknown") return { tone: "idle", text: "Sign-in not reported" };
  if (account.availability === "exhausted") return { tone: "problem", text: "Limit reached" };
  if (account.availability === "near_limit") return { tone: "action", text: "Near its limit" };
  return { tone: "ready", text: "Signed in" };
}

function Avatar(props: { text: string }) {
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-sm font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
    >
      {props.text.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProviderAccounts(props: {
  provider: ProviderKind;
  name: string;
  view: ReadinessView | undefined;
}) {
  const accounts = useAccountViews();
  const own = (accounts.data ?? [])
    .filter((account) => account.provider === props.provider)
    // The CLI's own sign-in first, then the rest as the daemon lists them.
    .toSorted((a, b) => Number(Boolean(b.implicit)) - Number(Boolean(a.implicit)));
  const manageable = canAddAccounts(props.provider);
  if (!own.length && !manageable) return null;
  return (
    <SettingSection label="Accounts" card>
      <ul aria-label={`${props.name} accounts`} className="divide-y">
        {own.map((account) => (
          <AccountItem
            key={account.id}
            account={account}
            provider={props.provider}
            name={props.name}
            view={props.view}
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
  view: ReadinessView | undefined;
  manageable: boolean;
  /** The provider's only account: no point saying which is the default. */
  only: boolean;
}) {
  const { account, name } = props;
  const now = useNow();
  const signIn = useSignIn();
  const actions = useAccountActions();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The CLI's own sign-in is named by who it is signed in as, when the CLI says.
  const label = account.implicit ? (props.view?.account ?? `Your ${name} sign-in`) : account.label;
  const how = account.implicit ? `${name}'s own sign-in` : "Added in ace";
  // The CLI's own sign-in stands where its readiness says, which knows more than its quota read.
  const view = props.view;
  const state =
    account.implicit && view
      ? { tone: view.tone, text: view.ready ? "Signed in" : view.label }
      : accountState(account);
  const fail = (title: string) => (error: unknown) =>
    toast.error({ title, description: error instanceof Error ? error.message : undefined });
  const provider = props.provider;
  const native = canAddAccounts(provider) ? provider : undefined;
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar text={label} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                <span className="shrink-0 rounded-full bg-secondary px-2 py-px text-xs text-muted-foreground">
                  Default
                </span>
              )}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className="shrink-0">{how}</span>
            <span aria-hidden>·</span>
            <StatusLine {...state} />
          </span>
        </div>
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
      {account.windows.length > 0 && (
        <div className="grid gap-x-6 gap-y-3 pl-11 text-sm sm:grid-cols-2">
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

/**
 * The last row: Add account. It asks only for a name, adds the account and opens its sign-in
 * at once, so there is no separate page for it.
 */
function AddAccount(props: { provider: ProviderKind; name: string }) {
  const signIn = useSignIn();
  const actions = useAccountActions();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const provider = props.provider;
  if (!signIn || !canAddAccounts(provider)) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return setError("Give the account a name, like Work.");
    setBusy(true);
    setError(undefined);
    try {
      const instance = await actions.add(provider, name);
      setOpen(false);
      setLabel("");
      signIn({ provider, instance });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't add the account.");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <li>
        <button
          type="button"
          onPointerEnter={() => void preloadSignIn()}
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-muted-foreground transition-colors duration-(--dur-1) focus-ring-inset hover:bg-accent hover:text-foreground"
        >
          <span className="grid size-8 place-items-center rounded-full border border-dashed">
            <PlusIcon aria-hidden size={14} />
          </span>
          <span className="font-medium">Add account</span>
        </button>
      </li>
    );
  return (
    <li className="fx-rise-in px-4 py-3">
      <form
        aria-label="Add account"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-2"
      >
        <label htmlFor="add-account-name" className="font-medium">
          Add a {props.name} account
        </label>
        <p className="text-sm text-muted-foreground">
          Name it, then sign in. ace keeps it separate from your other {props.name} sign-ins.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="add-account-name"
            autoFocus
            placeholder="Work"
            value={label}
            maxLength={128}
            aria-invalid={error !== undefined}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            className="max-w-64 flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Adding…" : "Add and sign in"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}
      </form>
    </li>
  );
}
