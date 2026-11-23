import { pluralCount } from "@ace/ui-core";
import {
  spadeCantRunBots,
  spadeChecksLine,
  spadeModelFacts,
  type SpadeEndpoint,
  type SpadeModelInfo,
} from "@ace/ui-core/spade-chat";
import { WarningCircleIcon } from "@ace/icons";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SearchField } from "@/components/search-field.tsx";
import { SettingList, SettingListItem, SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { checkModel, removeModel, saveModel } from "./spade-api.ts";
import { useSpadeClient } from "./spade-machine.tsx";
import { SpadeModelMark } from "./spade-marks.tsx";
import { fault } from "./spade-settings-rows.tsx";
import { modelsKey, useEndpointModels } from "./use-spade-models.ts";

/**
 * A provider's Models, as ace's provider page has them: first any model Spade's checks found
 * can't run a bot, with Check again (and while it runs, that it does); then for each account the models bots may use, and Manage,
 * which lists everything the provider itself offers, searchable, each on or off.
 */
export function SpadeProviderModels(props: { accounts: readonly SpadeEndpoint[] }) {
  const several = props.accounts.length > 1;
  return (
    <>
      <ModelProblems accounts={props.accounts} />
      {props.accounts.map((account) => (
        <AccountModels
          key={account.id}
          account={account}
          title={several ? account.name : undefined}
        />
      ))}
    </>
  );
}

function ModelProblems(props: { accounts: readonly SpadeEndpoint[] }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const problems = props.accounts.flatMap((account) =>
    account.models.flatMap((model) => {
      // A failed check, and the same model while Check again runs.
      const why = account.local ? spadeCantRunBots(model) : undefined;
      return why ? [{ account, model, why }] : [];
    }),
  );
  if (!problems.length) return null;
  const again = (account: SpadeEndpoint, model: SpadeModelInfo) =>
    void checkModel(client, account.id, model.id)
      .then(() => cache.invalidateQueries({ queryKey: modelsKey }))
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't check the model", description: fault(error) }),
      );
  return (
    <SettingList aria-label="Model problems">
      {problems.map(({ account, model, why }) => (
        <SettingListItem key={`${account.id}/${model.id}`} className="min-h-0 gap-1.5 py-2 text-xs">
          <WarningCircleIcon aria-hidden size={14} className="shrink-0 text-status-failed" />
          <span className="flex-1 text-muted-foreground">
            <span className="text-foreground">{model.name}</span> {why}
          </span>
          {model.checks?.state === "checked" && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Check ${model.name} again`}
              onClick={() => again(account, model)}
            >
              Check again
            </Button>
          )}
        </SettingListItem>
      ))}
    </SettingList>
  );
}

/** One account's line: how many models bots may use on it, and Manage. */
function AccountModels(props: { account: SpadeEndpoint; title: string | undefined }) {
  const [open, setOpen] = useState(false);
  const { account } = props;
  const title = props.title ?? "Models bots can use";
  const count = account.models.length;
  return (
    <SettingRow title={title} description={count ? pluralCount(count, "model") : "None yet"} inline>
      <Button
        size="sm"
        variant="secondary"
        aria-label={props.title ? `Manage ${props.title}'s models` : undefined}
        onClick={() => setOpen(true)}
      >
        Manage
      </Button>
      {open && <ManageModels account={account} onClose={() => setOpen(false)} />}
    </SettingRow>
  );
}

/**
 * Everything the account's provider lists, merged with the models saved on it, searchable. A
 * model on is saved, so bots may pick it; off, it goes. The preset's own models come with the
 * account and stay on.
 */
function ManageModels(props: { account: SpadeEndpoint; onClose(): void }) {
  const { account } = props;
  const [query, setQuery] = useState("");
  const { models, live } = useEndpointModels(account);
  const saved = new Set(account.models.map((model) => model.id));
  const words = query.trim().toLowerCase();
  const shown = words
    ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(words))
    : models;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{`Models on ${account.name}`}</DialogTitle>
        </DialogHeader>
        <SearchField
          label={`Search ${account.name}'s models`}
          placeholder="Search models"
          value={query}
          onValueChange={setQuery}
        />
        <div className="flex min-h-9 items-center gap-2 text-ui text-muted-foreground">
          <span className="min-w-0 flex-1">
            {`${saved.size} of ${pluralCount(models.length, "model")} on`}
          </span>
          {live.isFetching && <Spinner label="Reading the provider's list" />}
        </div>
        {live.isError && (
          <p className="text-xs text-muted-foreground">
            {`Couldn't read ${account.name}'s list, so only the saved models show.`}
          </p>
        )}
        <ul aria-label="Models" className="flex flex-col">
          {shown.map((model) => (
            <ModelRow key={model.id} account={account} model={model} on={saved.has(model.id)} />
          ))}
        </ul>
        {!shown.length && (
          <p className="py-2 text-ui text-muted-foreground">
            {words ? `No model matches "${query.trim()}".` : "This provider lists no models."}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModelRow(props: { account: SpadeEndpoint; model: SpadeModelInfo; on: boolean }) {
  const { account, model } = props;
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<boolean>();
  const facts = spadeModelFacts(model);
  const checks = account.local ? spadeChecksLine(model) : undefined;
  const failed = account.local && spadeCantRunBots(model) !== undefined;
  const fixed = model.source === "preset";
  const turn = (on: boolean) => {
    setPending(on);
    const change: Promise<unknown> = on
      ? saveModel(client, account.id, {
          id: model.id,
          name: model.name,
          ...(model.context ? { context: model.context } : {}),
          ...(model.capabilities.length ? { capabilities: model.capabilities } : {}),
        })
      : removeModel(client, account.id, model.id);
    void change
      .then(() => cache.invalidateQueries({ queryKey: modelsKey }))
      .catch((error: unknown) =>
        toast.error({
          title: `Couldn't turn ${model.name} ${on ? "on" : "off"}`,
          description: fault(error),
        }),
      )
      .finally(() => setPending(undefined));
  };
  return (
    <li className="flex min-h-11 items-center gap-2.5 border-b border-border-soft py-1.5 text-ui last:border-b-0">
      <SpadeModelMark model={model} account={account} size={16} decorative />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={model.id}>
          {model.name}
        </span>
        {(facts || checks) && (
          <span className="truncate text-xs text-subtle-foreground">
            {facts}
            {facts && checks && " · "}
            {checks && <span className={failed ? "text-status-failed" : undefined}>{checks}</span>}
          </span>
        )}
      </span>
      <Switch
        aria-label={`${model.name} on ${account.name}`}
        checked={pending ?? props.on}
        disabled={fixed || pending !== undefined}
        onCheckedChange={turn}
      />
    </li>
  );
}
