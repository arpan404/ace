import {
  spadeAccountState,
  spadeIsGatewayCompat,
  spadeUsedByWords,
  type SpadeAccountFix,
  type SpadeEndpoint,
} from "@ace/ui-core/spade-chat";
import { DotsThreeIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { AccountKeyMark } from "@/features/account-management/index.ts";
import { AccountRowFrame, AccountStateWords } from "@/features/settings/index.ts";
import { signOutAccount } from "./spade-accounts-api.ts";
import {
  GatewayTokenDialog,
  KeyDialog,
  RemoveDialog,
  RenameDialog,
} from "./spade-account-dialogs.tsx";
import { removeGatewayToken, removeKey } from "./spade-api.ts";
import { ChatgptSignInDialog } from "./spade-chatgpt-sign-in.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeProviderMark } from "./spade-marks.tsx";
import { fault } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/** A ChatGPT plan as people say it: "plus" reads "Plus". */
const plan = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** Who or where the account is, past its state: its ChatGPT login and plan, or its address. */
function whoItIs(account: SpadeEndpoint): string | undefined {
  if (account.auth === "chatgpt") {
    const { email, plan: tier } = account.account ?? {};
    return [email, tier && plan(tier)].filter(Boolean).join(" · ") || undefined;
  }
  // A preset's address is the preset's; one added by its address shows where it is.
  return account.provider ? undefined : account.baseUrl;
}

/**
 * One account of a Spade provider, as ace's Providers page shows an account: its mark and name
 * (with the key mark for a keyed one), its state when it isn't ready, who it is and the bots on
 * it; at the right the one fix it needs (Add key, Sign in) and a menu with the rest (Sign in
 * again, Replace key, Rename, Sign out, Remove account).
 */
export function SpadeAccountRow(props: {
  account: SpadeEndpoint;
  /** The provider's name, for the dialogs' titles. */
  provider: string;
  keychain: boolean;
  now: number;
  /** The fix asked for from outside (the page's problem line), opened at once. */
  fixing?: SpadeAccountFix | undefined;
  onFixed?(): void;
}) {
  const { account } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<"gateway" | "key" | "sign_in" | "rename" | "remove">();
  const showing = open ?? props.fixing;
  const close = () => {
    setOpen(undefined);
    props.onFixed?.();
  };
  const state = spadeAccountState(account, props.keychain, props.now);
  const who = whoItIs(account);
  const used = spadeUsedByWords(account.usedBy);
  const stateWords = state.tone !== "ready" && (
    <AccountStateWords tone={state.tone}>{state.text}</AccountStateWords>
  );
  const signedIn = account.auth === "chatgpt" && account.account?.signedIn === true;
  const keyed = account.auth === "key" && account.needsKey && props.keychain;
  // A gateway's own token is a second secret, kept beside the key (ADR 0119).
  const gateway = spadeIsGatewayCompat(account.baseUrl);
  const signOut = () =>
    void signOutAccount(client, account.id)
      .then(() => cache.invalidateQueries({ queryKey: modelsKey }))
      .catch((error: unknown) =>
        toast.error({ title: `Couldn't sign out ${account.name}`, description: fault(error) }),
      );
  const dropGateway = () =>
    void removeGatewayToken(client, account.id)
      .then(() => cache.invalidateQueries({ queryKey: modelsKey }))
      .catch((error: unknown) =>
        toast.error({
          title: `Couldn't remove the gateway token for ${account.name}`,
          description: fault(error),
        }),
      );
  const dropKey = () =>
    void removeKey(client, account.id)
      .then(() => cache.invalidateQueries({ queryKey: modelsKey }))
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't remove the key", description: fault(error) }),
      );
  return (
    <AccountRowFrame
      id={account.id}
      tone={state.tone}
      badge={<SpadeProviderMark account={account} name={props.provider} size={16} decorative />}
      label={account.name}
      marks={
        <AccountKeyMark method={account.auth === "key" && account.keySet ? "api_key" : undefined} />
      }
      sub={
        (stateWords || who || used) && (
          <>
            {stateWords}
            {stateWords && who && <span aria-hidden>·</span>}
            {who && (
              <span className={account.provider ? "truncate" : "truncate font-mono"}>{who}</span>
            )}
            {(stateWords || who) && used && <span aria-hidden>·</span>}
            {used && <span className="truncate">{used}</span>}
          </>
        )
      }
      right={
        <>
          {state.fix && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(state.fix)}>
              {state.fix === "key" ? "Add key" : "Sign in"}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <IconButton icon={DotsThreeIcon} label={`Manage ${account.name}`} size="sm" />
              }
            />
            <MenuContent align="end">
              {account.auth === "chatgpt" && (
                <MenuItem onClick={() => setOpen("sign_in")}>Sign in again</MenuItem>
              )}
              {keyed && account.keySet === true && (
                <MenuItem onClick={() => setOpen("key")}>Replace key</MenuItem>
              )}
              {gateway && (
                <MenuItem onClick={() => setOpen("gateway")}>
                  {account.gatewayTokenSet ? "Replace gateway token…" : "Set gateway token…"}
                </MenuItem>
              )}
              <MenuItem onClick={() => setOpen("rename")}>Rename</MenuItem>
              {(signedIn || (keyed && account.keySource === "keychain")) && <MenuSeparator />}
              {signedIn && <MenuItem onClick={signOut}>Sign out</MenuItem>}
              {keyed && account.keySource === "keychain" && (
                <MenuItem onClick={dropKey}>Remove key</MenuItem>
              )}
              {gateway && account.gatewayTokenSet && (
                <MenuItem onClick={dropGateway}>Remove gateway token</MenuItem>
              )}
              <MenuSeparator />
              <MenuItem danger onClick={() => setOpen("remove")}>
                Remove account…
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    >
      {showing === "key" && (
        <KeyDialog account={account} provider={props.provider} onClose={close} />
      )}
      {showing === "gateway" && (
        <GatewayTokenDialog account={account} provider={props.provider} onClose={close} />
      )}
      {showing === "sign_in" && (
        // A signed-out account is named; a signed-in one is renewed by signing in as it again.
        <ChatgptSignInDialog account={signedIn ? undefined : account.id} onClose={close} />
      )}
      {showing === "rename" && <RenameDialog account={account} onClose={close} />}
      {showing === "remove" && (
        <RemoveDialog account={account} provider={props.provider} onClose={close} />
      )}
    </AccountRowFrame>
  );
}
