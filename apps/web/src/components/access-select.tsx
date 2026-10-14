import type { AccessMode, AccessModeOffer } from "@ace/protocol";
import { accessLabel, accessModes } from "@ace/ui-core";
import { Select } from "./ui/select.tsx";

const inherit = "inherit";

/**
 * Pick one of ace's access modes, or leave the choice to the defaults (`inheritLabel`). Given
 * a provider's offers, only the modes it supports are listed.
 */
export function AccessSelect(props: {
  label: string;
  value: AccessMode | undefined;
  inheritLabel: string;
  offers?: readonly AccessModeOffer[] | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  onChange(value: AccessMode | undefined): void;
}) {
  const shown = props.offers ? props.offers.map((offer) => offer.mode) : accessModes;
  return (
    <Select
      label={props.label}
      {...(props.className ? { className: props.className } : {})}
      value={props.value ?? inherit}
      disabled={props.disabled === true}
      options={[
        { value: inherit, label: props.inheritLabel },
        ...shown.map((mode) => ({ value: mode, label: accessLabel(mode) })),
      ]}
      onValueChange={(picked) =>
        props.onChange(picked === inherit ? undefined : shown.find((mode) => mode === picked))
      }
    />
  );
}
