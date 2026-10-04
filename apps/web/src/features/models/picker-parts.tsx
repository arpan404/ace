import type { ProviderKind } from "@ace/protocol";
import { providerNames } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import {
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@/components/ui/menu.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";

/**
 * Inside a model trigger: the provider's icon, the model, then its account and effort in a
 * quieter tone. The account gives way first, then the model truncates, so a long name never
 * pushes the other controls or the send button.
 */
export function ModelChipLabel(props: {
  provider: ProviderKind | undefined;
  model: string;
  account?: string | undefined;
  effort?: string | undefined;
  /** A narrow composer: the model alone. */
  compact: boolean;
}) {
  return (
    <>
      {props.provider && <ProviderIcon provider={props.provider} />}
      <span className="min-w-0 truncate">{props.model}</span>
      {!props.compact && props.account && (
        <span className="min-w-0 shrink-[2] truncate font-normal text-subtle-foreground">
          {props.account}
        </span>
      )}
      {!props.compact && props.effort && (
        <span className="shrink-0 font-normal text-subtle-foreground">{props.effort}</span>
      )}
      <CaretDownIcon aria-hidden size={12} className="shrink-0" />
    </>
  );
}

/** A provider's group heading in a model menu. */
export function ProviderLabel(props: { provider: ProviderKind }) {
  return (
    <MenuLabel className="flex items-center gap-1.5">
      <ProviderIcon provider={props.provider} size={12} />
      {providerNames[props.provider]}
    </MenuLabel>
  );
}

/**
 * The effort levels of the chosen model, or one disabled row saying why effort can't change
 * (the model has none, or the provider sets it only when a thread starts).
 */
export function EffortSection(props: {
  efforts: readonly string[];
  value: string | undefined;
  reason?: string | undefined;
  onChange(effort: string): void;
}) {
  if (!props.efforts.length && !props.reason) return null;
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuLabel>Effort</MenuLabel>
        {props.reason ? (
          <MenuItem disabled reason={props.reason}>
            {props.value ?? "Default"}
          </MenuItem>
        ) : (
          <MenuRadioGroup
            value={props.value ?? ""}
            onValueChange={(value) => props.onChange(String(value))}
          >
            {props.efforts.map((option) => (
              <MenuRadioItem key={option} value={option} aria-label={`${option} effort`}>
                {option}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        )}
      </MenuGroup>
    </>
  );
}
