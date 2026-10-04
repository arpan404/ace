import type { ProviderKind } from "@ace/protocol";
import { effortLabel, providerNames } from "@ace/ui-core";
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
 * Inside a model trigger: the provider's icon, the model and its effort ("Opus 4.1 · High"),
 * then the account in a quieter tone. The account gives way first, then the model truncates,
 * so a long name never pushes the other controls or the send button.
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
      {props.provider && <ProviderIcon provider={props.provider} size={14} decorative />}
      <span className="min-w-0 truncate">{props.model}</span>
      {!props.compact && props.effort && (
        <span className="shrink-0">· {effortLabel(props.effort)}</span>
      )}
      {!props.compact && props.account && (
        <span className="min-w-0 shrink-[2] truncate font-normal text-subtle-foreground">
          {props.account}
        </span>
      )}
      <CaretDownIcon aria-hidden size={12} className="shrink-0" />
    </>
  );
}

/** A provider's group heading in a model menu. */
export function ProviderLabel(props: { provider: ProviderKind }) {
  return (
    <MenuLabel className="flex items-center gap-1.5">
      <ProviderIcon provider={props.provider} decorative />
      {providerNames[props.provider]}
    </MenuLabel>
  );
}

/**
 * The effort levels of the chosen model, or one disabled row saying why effort can't change
 * (the model has none, or the provider sets it only when a thread starts). When the daemon
 * doesn't report a thread's effort, a checked "Default (provider)" row says it runs at the
 * provider's default.
 */
export function EffortSection(props: {
  efforts: readonly string[];
  value: string | undefined;
  reason?: string | undefined;
  /** The provider whose default applies when the effort wasn't reported. */
  provider?: ProviderKind | undefined;
  /** False when `value` is ace's guess at the default rather than what the daemon reported. */
  reported?: boolean;
  /** Where the section sits: a separator goes between it and the models. */
  place?: "first" | "last";
  onChange(effort: string): void;
}) {
  if (!props.efforts.length && !props.reason) return null;
  const first = props.place === "first";
  const reported = props.reported ?? true;
  const owner = props.provider ? providerNames[props.provider] : "provider";
  return (
    <>
      {!first && <MenuSeparator />}
      <MenuGroup>
        <MenuLabel>Effort</MenuLabel>
        {props.reason ? (
          <MenuItem disabled reason={props.reason}>
            {props.value ? effortLabel(props.value) : `Default (${owner})`}
          </MenuItem>
        ) : (
          <MenuRadioGroup
            value={reported ? (props.value ?? defaultEffort) : defaultEffort}
            onValueChange={(value) => value !== defaultEffort && props.onChange(String(value))}
          >
            {!reported && (
              <MenuRadioItem value={defaultEffort} aria-label={`Default (${owner}) effort`}>
                Default ({owner})
                {props.value && (
                  <span className="ml-2 text-xs text-subtle-foreground">
                    {effortLabel(props.value)}
                  </span>
                )}
              </MenuRadioItem>
            )}
            {props.efforts.map((option) => (
              <MenuRadioItem
                key={option}
                value={option}
                aria-label={`${effortLabel(option)} effort`}
              >
                {effortLabel(option)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        )}
      </MenuGroup>
      {first && <MenuSeparator />}
    </>
  );
}

/** The radio value of "the provider's default", never an effort level's name. */
const defaultEffort = "\u0000default";
