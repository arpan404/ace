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
import { ProviderGlyph, providerNames } from "@/components/ui/provider-glyph.tsx";
import type { Resolved } from "./choices.ts";
import type { NewThreadOptions } from "./options-source.ts";

/**
 * Model and account in one chip ("Opus 4.6 personal ▾"). Models are grouped by provider; the
 * account list follows the chosen model's provider, each with how much quota it has left.
 */
export function ModelPicker(props: {
  options: NewThreadOptions | undefined;
  resolved: Resolved;
  onModel(id: string): void;
  onAccount(id: string): void;
}) {
  const { model, account } = props.resolved;
  const providers = [...new Set(props.options?.models.map((m) => m.provider) ?? [])];
  const accounts = props.options?.accounts.filter((a) => a.provider === model?.provider) ?? [];
  return (
    <Menu>
      <MenuTrigger
        disabled={!model}
        aria-label={`Model: ${model?.label ?? "loading"}${account ? `, account ${account.label}` : ""}`}
        className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-ui font-medium text-foreground outline-none transition-colors duration-150 hover:bg-accent aria-expanded:bg-accent disabled:opacity-50"
      >
        {model?.label ?? "Loading models…"}
        {account && <span className="font-normal text-subtle-foreground">{account.label}</span>}
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
                  <MenuRadioItem key={a.id} value={a.id} aria-label={`Account ${a.label}`}>
                    <span className="flex items-center gap-3">
                      {a.label}
                      <span className="ml-auto text-xs text-subtle-foreground">{a.usage}</span>
                    </span>
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
      <ProviderGlyph provider={props.provider} />
      {providerNames[props.provider]}
    </MenuLabel>
  );
}
