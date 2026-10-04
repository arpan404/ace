import { CaretDownIcon } from "@phosphor-icons/react";
import type { ProviderKind } from "@ace/protocol";
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
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { accountTag, providerNames } from "@ace/ui-core";
import type { NewThreadOptions, Resolved } from "./choices.ts";

/**
 * Model, account and effort in one chip ("Opus 4.6 personal high ▾"). Models are grouped by
 * provider; the account list follows the chosen model's provider, each with how much quota it
 * has left, and the efforts are the chosen model's.
 */
export function ModelPicker(props: {
  options: NewThreadOptions | undefined;
  resolved: Resolved;
  onModel(id: string): void;
  onAccount(id: string): void;
  onEffort(effort: string): void;
}) {
  const { model, account, effort } = props.resolved;
  const efforts = model?.efforts ?? [];
  const providers = [...new Set(props.options?.models.map((m) => m.provider) ?? [])];
  const accounts = props.options?.accounts.filter((a) => a.provider === model?.provider) ?? [];
  return (
    <Menu>
      <MenuTrigger
        disabled={!model}
        aria-label={`Model: ${model?.label ?? "loading"}${account ? `, account ${accountTag(account.label)}` : ""}${effort ? `, ${effort} effort` : ""}`}
        className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-ui font-medium text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent aria-expanded:bg-accent disabled:opacity-50"
      >
        {model && <ProviderIcon provider={model.provider} size={14} decorative />}
        {model?.label ?? "Loading models…"}
        {account && (
          <span className="font-normal text-subtle-foreground">{accountTag(account.label)}</span>
        )}
        {effort && <span className="font-normal text-subtle-foreground">{effort}</span>}
        <CaretDownIcon aria-hidden size={12} className="text-muted-foreground" />
      </MenuTrigger>
      <MenuContent align="end" side="top" className="max-h-[60vh] min-w-[260px] overflow-y-auto">
        <MenuRadioGroup value={model?.id ?? ""} onValueChange={(id) => props.onModel(String(id))}>
          {providers.map((provider, index) => (
            <MenuGroup key={provider}>
              {index > 0 && <MenuSeparator />}
              <ProviderLabel provider={provider} />
              {props.options?.models
                .filter((m) => m.provider === provider)
                .map((m) => (
                  <MenuRadioItem key={m.id} value={m.id}>
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
        {efforts.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel>Effort</MenuLabel>
              <MenuRadioGroup
                value={effort ?? ""}
                onValueChange={(value) => props.onEffort(String(value))}
              >
                {efforts.map((option) => (
                  <MenuRadioItem key={option} value={option} aria-label={`${option} effort`}>
                    {option}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function ProviderLabel(props: { provider: ProviderKind }) {
  return (
    <MenuLabel className="flex items-center gap-1.5">
      <ProviderIcon provider={props.provider} decorative />
      {providerNames[props.provider]}
    </MenuLabel>
  );
}
