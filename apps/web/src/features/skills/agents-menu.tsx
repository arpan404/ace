import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { orderedProviders } from "./library-model.ts";

const same = (a: readonly ProviderKind[], b: readonly ProviderKind[]) =>
  a.length === b.length && a.every((provider) => b.includes(provider));

/**
 * "Change" beside Agents: ticks are a draft while the menu is open, and closing it sends one
 * change, so quick ticks can't overwrite each other. A `locked` agent stays ticked: it reads the
 * skill's own folder, or keeps its own copy.
 */
export function AgentsMenu(props: {
  agents: readonly ProviderKind[];
  chosen: readonly ProviderKind[];
  locked?: (provider: ProviderKind) => boolean;
  disabled?: boolean;
  onCommit(providers: readonly ProviderKind[]): void;
}) {
  const [draft, setDraft] = useState<readonly ProviderKind[]>();
  const shown = draft ?? props.chosen;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) return setDraft(props.chosen);
        if (draft && !same(draft, props.chosen)) props.onCommit(draft);
        setDraft(undefined);
      }}
    >
      <MenuTrigger
        render={<Button variant="secondary" size="sm" disabled={props.disabled ?? false} />}
      >
        Change
      </MenuTrigger>
      <MenuContent align="end">
        {props.agents.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={shown.includes(provider)}
            disabled={(props.locked?.(provider) ?? false) && shown.includes(provider)}
            onCheckedChange={(on) =>
              setDraft(
                on
                  ? orderedProviders([...shown, provider])
                  : shown.filter((each) => each !== provider),
              )
            }
          >
            <span className="flex items-center gap-2">
              <ProviderIcon provider={provider} size={16} decorative />
              {providerNames[provider]}
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
