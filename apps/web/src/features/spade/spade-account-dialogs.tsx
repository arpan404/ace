import type { SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input, apiKeyFieldClassName } from "@/components/ui/input.tsx";
import { editEndpoint, removeEndpoint, setGatewayToken, setKey } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeProviderMark } from "./spade-marks.tsx";
import { fault } from "./spade-settings-rows.tsx";
import { modelsKey } from "./use-spade-models.ts";

/**
 * Runs one change to an account and reads the list again; a refusal stays in the dialog, in
 * Spade's words (removing one bots use, a key the keychain wouldn't take).
 */
function useAccountChange(onDone: () => void) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const run = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setRefusal(undefined);
    try {
      await change();
      await cache.invalidateQueries({ queryKey: modelsKey });
      onDone();
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, refusal, run };
}

function Shell(props: {
  title: string;
  account: Pick<SpadeEndpoint, "id" | "provider">;
  providerName: string;
  description?: ReactNode;
  refusal: string | undefined;
  onClose(): void;
  onSubmit(): void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SpadeProviderMark
                account={props.account}
                name={props.providerName}
                size={20}
                decorative
              />
              {props.title}
            </DialogTitle>
            {props.description && <DialogDescription>{props.description}</DialogDescription>}
          </DialogHeader>
          {(props.children || props.refusal) && (
            <DialogBody>
              {props.children}
              {props.refusal && (
                <p role="alert" className="text-ui text-destructive">
                  {props.refusal}
                </p>
              )}
            </DialogBody>
          )}
          <DialogFooter>{props.footer}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An account's key: typed here, it goes to Spade in one request, which keeps it in the OS
 * keychain; the field empties as it goes, so the key lives only in that call.
 */
export function KeyDialog(props: { account: SpadeEndpoint; provider: string; onClose(): void }) {
  const client = useSpadeClient();
  const field = useId();
  const [draft, setDraft] = useState("");
  const change = useAccountChange(props.onClose);
  const save = () => {
    const key = draft.trim();
    if (!key) return;
    setDraft("");
    void change.run(() => setKey(client, props.account.id, key));
  };
  const replacing = props.account.keySet === true;
  return (
    <Shell
      account={props.account}
      providerName={props.provider}
      title={`${replacing ? "Replace" : "Add"} the key for ${props.account.name}`}
      description="Spade keeps it in this computer's keychain and never shows it again."
      refusal={change.refusal}
      onClose={props.onClose}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={change.busy || !draft.trim()}>
            {change.busy ? "Saving…" : "Save key"}
          </Button>
        </>
      }
    >
      <label htmlFor={field} className="sr-only">
        {props.provider} key
      </label>
      <Input
        id={field}
        name="spade-api-key"
        type="password"
        autoComplete="one-time-code"
        data-1p-ignore=""
        data-lpignore="true"
        spellCheck={false}
        placeholder="Paste key"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opened for the key.
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={change.busy}
        className={apiKeyFieldClassName}
      />
    </Shell>
  );
}

/**
 * An authenticated gateway's own token (Cloudflare AI Gateway's `cf-aig-authorization`): typed
 * here, it goes to Spade in one request, which keeps it in the OS keychain beside the key. It is
 * never stored with the endpoint, so nothing of it is shown again.
 */
export function GatewayTokenDialog(props: {
  account: SpadeEndpoint;
  provider: string;
  onClose(): void;
}) {
  const client = useSpadeClient();
  const field = useId();
  const [draft, setDraft] = useState("");
  const change = useAccountChange(props.onClose);
  const save = () => {
    const token = draft.trim();
    if (!token) return;
    setDraft("");
    void change.run(() => setGatewayToken(client, props.account.id, token));
  };
  const replacing = props.account.gatewayTokenSet;
  return (
    <Shell
      account={props.account}
      providerName={props.provider}
      title={`${replacing ? "Replace" : "Add"} the gateway token for ${props.account.name}`}
      description="Only an authenticated gateway needs one. Spade keeps it in this computer's keychain and never shows it again."
      refusal={change.refusal}
      onClose={props.onClose}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={change.busy || !draft.trim()}>
            {change.busy ? "Saving…" : "Save token"}
          </Button>
        </>
      }
    >
      <label htmlFor={field} className="sr-only">
        {props.provider} gateway token
      </label>
      <Input
        id={field}
        name="spade-gateway-token"
        type="password"
        autoComplete="one-time-code"
        data-1p-ignore=""
        data-lpignore="true"
        spellCheck={false}
        placeholder="Paste gateway token"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opened for the token.
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={change.busy}
      />
    </Shell>
  );
}

/** Renaming changes only the name people see: the account's id, and every model on it, stay. */
export function RenameDialog(props: { account: SpadeEndpoint; onClose(): void }) {
  const client = useSpadeClient();
  const field = useId();
  const [draft, setDraft] = useState(props.account.name);
  const change = useAccountChange(props.onClose);
  const save = () => {
    const name = draft.trim();
    if (!name || name === props.account.name) return props.onClose();
    void change.run(() => editEndpoint(client, props.account.id, { name }));
  };
  return (
    <Shell
      account={props.account}
      providerName={props.account.name}
      title={`Rename ${props.account.name}`}
      refusal={change.refusal}
      onClose={props.onClose}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={change.busy || !draft.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={field} className="w-fit text-ui font-medium">
          Name
        </label>
        <Input
          id={field}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog opened to rename.
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={change.busy}
        />
      </div>
    </Shell>
  );
}

/** What else goes when an account is removed. */
const goesWith = (account: SpadeEndpoint) => {
  if (account.auth === "chatgpt") return " Its sign-in leaves the keychain too.";
  return account.needsKey ? " Its key leaves the keychain too." : "";
};

/** Asks once; Spade refuses while bots use the account, and says which. */
export function RemoveDialog(props: { account: SpadeEndpoint; provider: string; onClose(): void }) {
  const client = useSpadeClient();
  const change = useAccountChange(props.onClose);
  return (
    <Shell
      account={props.account}
      providerName={props.provider}
      title={`Remove ${props.account.name} from ${props.provider}?`}
      description={`Bots can't use its models after this.${goesWith(props.account)}`}
      refusal={change.refusal}
      onClose={props.onClose}
      onSubmit={() => void change.run(() => removeEndpoint(client, props.account.id))}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={change.busy}>
            {change.busy ? "Removing…" : "Remove account"}
          </Button>
        </>
      }
    />
  );
}
