import type { AceOrgSpace } from "@ace/protocol/ace-org";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useOpenMarket } from "@/lib/open-market.ts";

/**
 * Settings › Organization › Registry (ADR 0206 §5): the organization's private packages, on the
 * Marketplace under its own publisher, seen only by its members. Every version is scanned like
 * any package and signed with the organization's own key, on a machine its owners choose; ace's
 * servers never hold it.
 */
export function RegistryPage(props: { org: AceOrgSpace }) {
  const openMarket = useOpenMarket();
  const { name } = props.org;
  return (
    <>
      <SettingSection label="Private registry" anchor="org.registry">
        <SettingRow
          title={`${name}'s packages`}
          description={`Bots, skills and plugins only ${name}'s members can find and install.`}
          inline
        >
          <Button size="sm" variant="ghost" onClick={() => openMarket("installed")}>
            Open Marketplace
          </Button>
        </SettingRow>
        <SettingRow
          title="Publish a package"
          description="Scanned like every package. It's offered once the organization's key signs it."
          inline
        >
          <Button size="sm" variant="ghost" onClick={() => openMarket("publish")}>
            Publish
          </Button>
        </SettingRow>
      </SettingSection>
      <SettingSection label="Signing key" anchor="org.registry.key">
        <SettingRow
          title="Kept on one machine"
          description="An owner chooses it, ideally a host, so it signs while people sleep. Each device asks once before it trusts the key."
        />
      </SettingSection>
    </>
  );
}
