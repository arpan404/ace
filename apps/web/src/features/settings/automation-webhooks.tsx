import { webhookWays } from "@ace/ui-core/automations";
import { HairlineRow, RowGroup } from "@/components/hairline-row.tsx";
import { automationsQueryKey } from "@/features/automation-data/index.ts";
import { settingKeys, type SettingDef } from "./data/setting-keys.ts";
import { useSettingControl } from "./data/use-settings.ts";
import { PathSwitch } from "./path-switch.tsx";

/**
 * Settings › a machine › Automation webhooks: one switch per way a signed webhook can reach
 * this machine (ADR 0173, decision 3), apart from outside apps' switches. Each reloads the
 * automation lists, whose webhooks list a URL per way that serves.
 */
export function AutomationWebhooks() {
  const publicUrl = useSettingControl(settingKeys.mcpPublicUrl, "Your own URL");
  const hasUrl = Boolean(publicUrl.value);
  return (
    <RowGroup label="Automation webhooks" anchor="automation-webhooks">
      <WayRow
        id="webhooks-custom"
        title={webhookWays.custom.title}
        label={webhookWays.custom.label}
        setting={settingKeys.publicUrlWebhooks}
        sub={hasUrl ? webhookWays.custom.sub : webhookWays.custom.blocked}
        blocked={!hasUrl}
      />
      <WayRow
        id="webhooks-tailscale"
        title={webhookWays.tailscale.title}
        label={webhookWays.tailscale.label}
        setting={settingKeys.tailscaleWebhooks}
        sub={webhookWays.tailscale.sub}
      />
      <WayRow
        id="webhooks-relay"
        title={webhookWays.relay.title}
        label={webhookWays.relay.label}
        setting={settingKeys.relayWebhooks}
        sub={webhookWays.relay.sub}
      />
    </RowGroup>
  );
}

function WayRow(props: {
  id: string;
  title: string;
  /** The switch's name, read apart from the group. */
  label: string;
  setting: SettingDef<boolean>;
  sub: string;
  blocked?: boolean;
}) {
  return (
    <HairlineRow
      id={props.id}
      title={props.title}
      wide
      sub={props.sub}
      actions={
        <PathSwitch
          setting={props.setting}
          title={props.label}
          refreshes={automationsQueryKey}
          blocked={props.blocked === true}
        />
      }
    />
  );
}
