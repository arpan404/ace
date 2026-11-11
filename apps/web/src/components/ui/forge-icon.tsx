import type { ForgeKind } from "@ace/protocol/forge";
import { forgeDisplayName } from "@ace/ui-core";
import { BrandMark, type BrandMarkProps } from "./provider-icons.tsx";

/**
 * A Git host provider's mark (GitHub, GitLab, Bitbucket…), drawn like every provider mark: it
 * loads with the brand tables, keeps its box meanwhile and follows the theme. Which mark stands
 * for which provider is `forgeBrands` in `@ace/ui-core/provider-icons`, shared with mobile.
 */
export function ForgeIcon(props: BrandMarkProps & { forge: ForgeKind }) {
  const name = forgeDisplayName(props.forge);
  return (
    <BrandMark
      {...props}
      choose={(tables) => ({ brand: tables.forgeBrands[props.forge], label: name })}
      fallbackLabel={name}
    />
  );
}
