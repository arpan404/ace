import {
  spadePermissionSwitches,
  type SpadePermissionKey,
  type SpadePermissions,
} from "@ace/ui-core/spade-chat";
import { useState, type ReactNode } from "react";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { SettingRow } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

/**
 * A bot's Permissions, or the default every bot follows (ADR 0171, amendment 7): one plain line
 * and a switch per kind of reach. Turning one on is the person's alone: a window that hasn't
 * proved it is theirs shows Confirm it's you in the row, and the switch turns on once they do.
 * A refusal says why in the row. On a bot, a switch it sets itself offers Use default.
 */
export function PermissionRows(props: {
  permissions: SpadePermissions;
  /** On a bot: a switch it sets itself offers Use default (`null`). */
  bot?: boolean;
  save(key: SpadePermissionKey, on: boolean | null): Promise<unknown>;
  /** What sits under a row, by its switch: the never-use list under Computer use. */
  under?: Partial<Record<SpadePermissionKey, ReactNode>>;
}) {
  return (
    <>
      {spadePermissionSwitches.map((each) => (
        <PermissionRow
          key={each.key}
          title={each.title}
          line={each.line}
          on={props.permissions.on[each.key]}
          own={props.bot === true && props.permissions.own[each.key]}
          save={(on) => props.save(each.key, on)}
          under={props.under?.[each.key]}
        />
      ))}
    </>
  );
}

function PermissionRow(props: {
  title: string;
  line: string;
  on: boolean;
  own: boolean;
  save(on: boolean | null): Promise<unknown>;
  under: ReactNode;
}) {
  const client = useSpadeClient();
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  /** The change waiting on Confirm it's you. */
  const [confirming, setConfirming] = useState<boolean | null>();
  const change = async (on: boolean | null) => {
    setSaving(true);
    setRefusal(undefined);
    setConfirming(undefined);
    try {
      await props.save(on);
    } catch (error) {
      const message = fault(error);
      if (isStandingRefusal(message)) setConfirming(on);
      else setRefusal(message);
    } finally {
      setSaving(false);
    }
  };
  const description =
    confirming !== undefined ? (
      <ConfirmPerson client={client} onConfirmed={() => void change(confirming)} />
    ) : refusal ? (
      <Refusal>{refusal}</Refusal>
    ) : (
      props.line
    );
  return (
    <>
      <SettingRow title={props.title} description={description} density="compact" inline>
        <div className="flex items-center gap-2">
          {props.own && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => void change(null)}>
              Use default
            </Button>
          )}
          <Switch
            aria-label={props.title}
            checked={props.on}
            disabled={saving}
            onCheckedChange={(on) => void change(on)}
          />
        </div>
      </SettingRow>
      {props.under}
    </>
  );
}
