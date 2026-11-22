import type { SpadePreset, SpadeProviderGroup } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  SettingAddRow,
  SettingCard,
  SettingsGroupTitle,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { addPresetAccount } from "./spade-accounts-api.ts";
import { AccountCard } from "./spade-account-card.tsx";
import { ChatgptSignInDialog } from "./spade-chatgpt-sign-in.tsx";
import { SpadeChoices } from "./spade-choices.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/**
 * One provider (ADR 0213): its name, each of its accounts on its own surface, then Add an
 * account. OpenAI's offers a ChatGPT sign-in or an API key; another preset's adds a keyed
 * account by name. An account added by its address is its own provider, with no Add.
 */
export function ProviderSection(props: {
  group: SpadeProviderGroup;
  presets: readonly SpadePreset[];
  keychain: boolean;
  /** The sign-ins this Spade can run. */
  signIn: readonly string[];
}) {
  const { group } = props;
  const heading = useId();
  const [adding, setAdding] = useState(false);
  const preset = props.presets.find((each) => each.id === group.provider);
  const chatgpt = group.provider === "openai" && props.signIn.includes("chatgpt");
  return (
    <section aria-labelledby={heading} className={settingsGroup}>
      <SettingsGroupTitle id={heading}>{group.name}</SettingsGroupTitle>
      <div className="flex flex-col gap-2">
        {group.accounts.map((account) => (
          <AccountCard key={account.id} endpoint={account} keychain={props.keychain} />
        ))}
        {(preset || chatgpt) && (
          <SettingCard>
            <SettingAddRow
              aria-label={`Add ${article(group.name)} ${group.name} account`}
              onClick={() => setAdding(true)}
            >
              Add an account
            </SettingAddRow>
          </SettingCard>
        )}
      </div>
      {adding && (
        <AddAccountDialog
          name={group.name}
          preset={preset}
          chatgpt={chatgpt}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

const article = (name: string) => (/^[aeiou]/i.test(name) ? "an" : "a");

/**
 * Another account of a provider: how it signs in where there is a choice (OpenAI: a ChatGPT
 * sign-in or an API key), and for a key, its name. The key is pasted on the account's row once
 * it is added, never here. With only a ChatGPT sign-in to offer, it is the sign-in at once.
 */
function AddAccountDialog(props: {
  name: string;
  preset: SpadePreset | undefined;
  chatgpt: boolean;
  onClose(): void;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const [way, setWay] = useState<"chatgpt" | "key">(props.chatgpt ? "chatgpt" : "key");
  const [signingIn, setSigningIn] = useState(props.chatgpt && !props.preset);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (signingIn) return <ChatgptSignInDialog onClose={props.onClose} />;
  const add = async () => {
    if (!props.preset || !name.trim()) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await addPresetAccount(client, props.preset.id, name.trim());
      await cache.invalidateQueries({ queryKey: modelsKey });
      props.onClose();
    } catch (error) {
      setProblem(fault(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Add ${article(props.name)} ${props.name} account`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {props.chatgpt && (
            <SpadeChoices<"chatgpt" | "key">
              label="How it signs in"
              value={way}
              onChange={setWay}
              choices={[
                {
                  value: "chatgpt",
                  label: "Sign in with ChatGPT",
                  description: "Bots on it use your ChatGPT plan.",
                },
                {
                  value: "key",
                  label: "API key",
                  description: `Billed to ${props.name} API use. You paste the key once it's added.`,
                },
              ]}
            />
          )}
          {way === "key" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={field} className="w-fit text-ui font-medium">
                Name
              </label>
              <Input
                id={field}
                placeholder="Work"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add();
                }}
              />
            </div>
          )}
          {problem && (
            <p role="alert" className="text-ui text-destructive">
              {problem}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {way === "chatgpt" ? (
            <Button variant="primary" onClick={() => setSigningIn(true)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" disabled={saving || !name.trim()} onClick={() => void add()}>
              {saving ? "Adding…" : "Add account"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
