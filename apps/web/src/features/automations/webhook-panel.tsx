import type { AutomationSource, AutomationWebhookState } from "@ace/protocol";
import { CheckIcon, CopyIcon } from "@ace/icons";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirming } from "@/components/confirm-dialog.tsx";
import { StateWords } from "@/components/hairline-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useCopy } from "@/components/use-copy.ts";
import { useAutomationActions } from "@/features/automation-data/index.ts";

/*
 * A webhook automation's address and secret (ADR 0158): the URL senders post to, or why there
 * is none; the person's Create, Rotate and Revoke; the new secret once, right after it's made;
 * and the headers and prompt variables senders and prompts use. The secret lives only in this
 * component's state, so closing it or leaving the screen loses it for good.
 */

const code = "rounded-xs bg-secondary px-1 font-mono text-foreground";

export function WebhookPanel(props: {
  automationId: string;
  source: AutomationSource;
  webhook: AutomationWebhookState | undefined;
  /** Writes can't be sent: offline, or another change is in flight. */
  disabled: boolean;
}) {
  const { webhookSecret } = useAutomationActions();
  const toast = useToast();
  const [secret, setSecret] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>();
  // The reply's state stands until the list read after it arrives, so Create secret can't be
  // pressed again in between and replace the secret just shown.
  const [replied, setReplied] = useState<{ webhook: AutomationWebhookState; over: unknown }>();
  const webhook = replied && replied.over === props.webhook ? replied.webhook : props.webhook;
  const active = webhook?.active === true;
  const send = (action: "rotate" | "revoke") => {
    setPending(true);
    const over = props.webhook;
    webhookSecret(props.automationId, action, props.source).then(
      (result) => {
        setPending(false);
        setSecret(result.secret);
        if (result.webhook) setReplied({ webhook: result.webhook, over });
      },
      (error: unknown) => {
        setPending(false);
        toast.error({
          title: error instanceof Error ? error.message : "Couldn't change the webhook's secret.",
        });
      },
    );
  };
  const busy = props.disabled || pending;
  return (
    <section
      aria-label="Webhook"
      className="mt-6 flex flex-col gap-2.5 rounded-lg border border-border px-3 py-2.5 text-ui"
    >
      <div className="flex min-h-7 items-center gap-3">
        <h3 className="flex-1 text-muted-foreground">Webhook</h3>
        <div className="-mr-1.5 flex shrink-0 items-center gap-1">
          {active ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setConfirming({
                    title: "Rotate this webhook's secret?",
                    body: "The current secret stops working at once. Senders need the new one.",
                    confirm: "Rotate secret",
                    run: () => send("rotate"),
                  })
                }
              >
                Rotate secret
              </Button>
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                disabled={busy}
                onClick={() =>
                  setConfirming({
                    title: "Revoke this webhook's secret?",
                    body: "The secret stops working and the address stops answering. A new secret gets a new address.",
                    confirm: "Revoke",
                    run: () => send("revoke"),
                  })
                }
              >
                Revoke
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => send("rotate")}>
              Create secret
            </Button>
          )}
        </div>
      </div>
      <Address webhook={webhook} />
      {secret && <SecretReveal secret={secret} onDone={() => setSecret(undefined)} />}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Senders sign with Standard Webhooks headers: <Code>webhook-id</Code>,{" "}
        <Code>webhook-timestamp</Code>, <Code>webhook-signature</Code>. In the prompt:{" "}
        <Code>{"{{body.field}}"}</Code> for a JSON body field, <Code>{"{{body.a.b}}"}</Code> nested,{" "}
        <Code>{"{{body.items.0}}"}</Code> an array item, <Code>{"{{webhook.id}}"}</Code> the
        delivery id.
      </p>
      <ConfirmDialog confirming={confirming} onDone={() => setConfirming(undefined)} />
    </section>
  );
}

function Code(props: { children: ReactNode }) {
  return <code className={code}>{props.children}</code>;
}

/** The URL with Copy; why there is none; or that it needs a secret first. */
function Address(props: { webhook: AutomationWebhookState | undefined }) {
  const { webhook } = props;
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the address and copy it yourself." }),
  );
  if (webhook?.url)
    return (
      <span className="-my-1 flex min-w-0 items-center gap-0.5">
        <span className="min-w-0 font-mono text-sm break-all text-foreground">{webhook.url}</span>
        <IconButton
          icon={copied ? CheckIcon : CopyIcon}
          label={copied ? "Copied" : "Copy address"}
          size="sm"
          type="button"
          onClick={() => copy(webhook.url ?? "")}
        />
      </span>
    );
  if (webhook?.problem)
    return (
      <p className="text-muted-foreground">
        <StateWords tone="warn">{webhook.problem}</StateWords>
      </p>
    );
  return <p className="text-muted-foreground">No secret yet</p>;
}

/** The new secret, once: Copy, what holding it allows, and Done to put it away for good. */
function SecretReveal(props: { secret: string; onDone(): void }) {
  const toast = useToast();
  const { copied, copy } = useCopy(() =>
    toast.error({ title: "Couldn't copy. Select the secret and copy it yourself." }),
  );
  return (
    <div className="flex flex-col gap-2 rounded-md bg-secondary px-2.5 py-2">
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 font-mono text-sm break-all text-foreground">
          {props.secret}
        </code>
        <IconButton
          icon={copied ? CheckIcon : CopyIcon}
          label={copied ? "Copied" : "Copy secret"}
          size="sm"
          type="button"
          onClick={() => copy(props.secret)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Copy it now: it won't be shown again. Anyone with it can send text into this automation's
          prompt.
        </p>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
