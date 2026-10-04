import { accountTag, providerNames } from "@ace/ui-core";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { EffortSection, ModelChipLabel, ProviderLabel } from "@/features/models/index.ts";
import { composerChip, useComposerCompact } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import type { NewThreadOptions, Resolved } from "./choices.ts";

/**
 * Model, account and effort in one footer chip ("◆ Opus 4.6 personal high ▾"), the same chip
 * the thread's composer shows. Models are grouped by provider; the account list follows the
 * chosen model's provider, each with how much quota it has left, and the efforts are the
 * chosen model's.
 */
export function ModelPicker(props: {
  options: NewThreadOptions | undefined;
  resolved: Resolved;
  /** Called with the option's `key`, which tells apart providers that share a model id. */
  onModel(key: string): void;
  onAccount(id: string): void;
  onEffort(effort: string): void;
}) {
  const { model, account, effort } = props.resolved;
  const efforts = model?.efforts ?? [];
  const providers = [...new Set(props.options?.models.map((m) => m.provider) ?? [])];
  const accounts = props.options?.accounts.filter((a) => a.provider === model?.provider) ?? [];
  const tag = account ? accountTag(account.label) : undefined;
  const compact = useComposerCompact();
  // Discovery found no provider CLI: say so rather than waiting for models that won't come.
  const none = props.options !== undefined && props.options.models.length === 0;
  const empty = none ? "No provider CLI installed" : "Loading models…";
  return (
    <Menu>
      <Tip
        label={
          model
            ? [providerNames[model.provider], model.label, tag, effort].filter(Boolean).join(" · ")
            : empty
        }
        side="top"
      >
        <MenuTrigger
          disabled={!model}
          aria-label={`Model: ${model?.label ?? (none ? "no provider installed" : "loading")}${tag ? `, account ${tag}` : ""}${effort ? `, ${effort} effort` : ""}`}
          className={cn(composerChip, "max-w-64")}
        >
          {model ? (
            <ModelChipLabel
              provider={model.provider}
              model={model.label}
              account={tag}
              effort={effort}
              compact={compact}
            />
          ) : (
            <span className="truncate">{empty}</span>
          )}
        </MenuTrigger>
      </Tip>
      <MenuContent align="start" side="top" className="max-h-[60vh] w-[320px] overflow-y-auto">
        <MenuRadioGroup
          value={model?.key ?? ""}
          onValueChange={(key) => props.onModel(String(key))}
        >
          {providers.map((provider, index) => (
            <MenuGroup key={provider}>
              {index > 0 && <MenuSeparator />}
              <ProviderLabel provider={provider} />
              {props.options?.models
                .filter((m) => m.provider === provider)
                .map((m) => (
                  <MenuRadioItem key={m.key} value={m.key}>
                    {m.label}
                  </MenuRadioItem>
                ))}
            </MenuGroup>
          ))}
        </MenuRadioGroup>
        {accounts.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel>Account</MenuLabel>
              <MenuRadioGroup
                value={account?.id ?? ""}
                onValueChange={(id) => props.onAccount(String(id))}
              >
                {accounts.map((a) => (
                  <MenuRadioItem
                    key={a.id}
                    value={a.id}
                    aria-label={`Account ${accountTag(a.label)}`}
                  >
                    <span className="flex items-center gap-3">
                      {accountTag(a.label)}
                      <span className="ml-auto text-xs text-subtle-foreground">{a.usage}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
        <EffortSection
          efforts={efforts}
          value={effort}
          reason={undefined}
          onChange={props.onEffort}
        />
      </MenuContent>
    </Menu>
  );
}
