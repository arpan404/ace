import { betaSwitches } from "@ace/ui-core";
import { SettingSection } from "@/components/setting-row.tsx";
import { settingKeys } from "./data/setting-keys.ts";
import { SettingSwitch } from "./setting-switch.tsx";

/** Features still being tried out on this machine, each one switch that goes back freely. */
export function BetaSettings() {
  return (
    <>
      <SettingSection label="Features" scope="daemon">
        <SettingSwitch
          setting={settingKeys.betaSpade}
          entry="beta.spade"
          description={betaSwitches.spade.description}
        />
        <SettingSwitch
          setting={settingKeys.betaMarketplace}
          entry="beta.marketplace"
          description={betaSwitches.marketplace.description}
        />
        <SettingSwitch
          setting={settingKeys.marketAskBeforeAgentPublish}
          entry="market.askBeforeAgentPublish"
        />
      </SettingSection>
    </>
  );
}
