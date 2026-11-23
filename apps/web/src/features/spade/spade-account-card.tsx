import {
  spadeAccountWords,
  spadeChecksLine,
  spadeFormatNames,
  spadeModelFacts,
  type SpadeEndpoint,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingAddRow, SettingCard, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { signOutAccount } from "./spade-accounts-api.ts";
import { AccountHead } from "./spade-account-head.tsx";
import { KeyRow, onHover } from "./spade-account-key.tsx";
import { checkModel, removeModel, saveModel } from "./spade-api.ts";
import { ChatgptSignInDialog } from "./spade-chatgpt-sign-in.tsx";
import { modelsKey } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelChoice } from "./spade-model-picker.tsx";
import { fault, Refusal } from "./spade-settings-rows.tsx";

/**
 * One account of a provider (ADR 0214), on its own surface: its name, the bots on it, Rename and
 * Remove; where it is when it was added by its address; how it signs in (its key, saved or not
 * and never shown, or its ChatGPT sign-in); the models saved on it (the person's own can go) and
 * Add a model.
 */
export function AccountCard(props: { endpoint: SpadeEndpoint; keychain: boolean }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const refresh = () => cache.invalidateQueries({ queryKey: modelsKey });
  const dropModel = async (model: string) => {
    try {
      await removeModel(client, endpoint.id, model);
      await refresh();
    } catch (error) {
      toast.error({ title: "Couldn't remove the model", description: fault(error) });
    }
  };
  const recheck = async (model: string) => {
    try {
      await checkModel(client, endpoint.id, model);
      await refresh();
    } catch (error) {
      toast.error({ title: "Couldn't check the model", description: fault(error) });
    }
  };
  return (
    <div role="group" aria-label={endpoint.name}>
      <SettingCard>
        <AccountHead endpoint={endpoint} />
        {/* A preset's address is the preset's; one added by its address shows where it is. */}
        {!endpoint.provider && (
          <SettingRow
            title="Address"
            description={<span className="font-mono break-all">{endpoint.baseUrl}</span>}
            density="compact"
          >
            {endpoint.format && (
              <span className="text-ui text-muted-foreground">
                {spadeFormatNames[endpoint.format]}
              </span>
            )}
          </SettingRow>
        )}
        {endpoint.auth === "chatgpt" && <SignInRow endpoint={endpoint} />}
        {endpoint.auth === "key" && endpoint.needsKey && (
          <KeyRow endpoint={endpoint} keychain={props.keychain} />
        )}
        {endpoint.models.map((model) => (
          <SettingRow
            key={model.id}
            title={model.name}
            description={
              <>
                <span className="font-mono">{model.id}</span>
                {spadeModelFacts(model) && ` · ${spadeModelFacts(model)}`}
                {endpoint.local && spadeChecksLine(model) && (
                  <span className="block">{spadeChecksLine(model)}</span>
                )}
              </>
            }
            density="compact"
            inline
          >
            {/* Only the person's saved models can go; the preset's come with the endpoint. */}
            {model.source !== "preset" && (
              <div className={onHover}>
                {endpoint.local && model.checks?.state !== "checking" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Check ${model.name} again`}
                    onClick={() => void recheck(model.id)}
                  >
                    Check again
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${model.name}`}
                  onClick={() => void dropModel(model.id)}
                >
                  Remove
                </Button>
              </div>
            )}
          </SettingRow>
        ))}
        <AddModelRow endpoint={endpoint} />
      </SettingCard>
    </div>
  );
}

/**
 * A ChatGPT account's sign-in: who it is signed in as, or signed out, with Sign in again and
 * Sign out. Signing out keeps the account and the bots on it; they wait for a new sign-in.
 */
function SignInRow(props: { endpoint: SpadeEndpoint }) {
  const { endpoint } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const signOut = async () => {
    setBusy(true);
    setRefusal(undefined);
    try {
      await signOutAccount(client, endpoint.id);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      title="ChatGPT sign-in"
      description={refusal ? <Refusal>{refusal}</Refusal> : spadeAccountWords(endpoint, true)}
      density="compact"
      inline
    >
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setSigningIn(true)} disabled={busy}>
          Sign in again
        </Button>
        {endpoint.account?.signedIn && (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={busy}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        )}
      </div>
      {signingIn && (
        <ChatgptSignInDialog
          // A signed-out account is named; a signed-in one is renewed by signing in as it again.
          account={endpoint.account?.signedIn ? undefined : endpoint.id}
          onClose={() => setSigningIn(false)}
        />
      )}
    </SettingRow>
  );
}

/**
 * Add a model: a row that opens the models the endpoint lists (the same list the chat's picker
 * reads), searchable, or an id typed in; the one picked is saved, so it is offered first.
 */
function AddModelRow(props: { endpoint: SpadeEndpoint }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  if (!adding) return <SettingAddRow onClick={() => setAdding(true)}>Add a model</SettingAddRow>;
  const add = async (id: string) => {
    if (!id.trim()) return;
    setSaving(true);
    setRefusal(undefined);
    try {
      await saveModel(client, props.endpoint.id, { id: id.trim() });
      setAdding(false);
      await cache.invalidateQueries({ queryKey: modelsKey });
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      title="Model"
      description={refusal && <Refusal>{refusal}</Refusal>}
      htmlFor={field}
      density="compact"
    >
      <div className="flex items-center gap-1.5">
        <SpadeModelChoice
          id={field}
          label="Model to add"
          endpoint={props.endpoint}
          model=""
          omit={props.endpoint.models.map((model) => model.id)}
          opened
          onChange={(id) => void add(id)}
        />
        <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </SettingRow>
  );
}
