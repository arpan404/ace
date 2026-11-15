import type { ForgeKind } from "@ace/protocol/forge";
import { forgeDisplayName } from "@ace/ui-core";
import type { IconGlyph } from "../icon.tsx";
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

const brandSizes = [12, 14, 16, 18, 20, 24] as const;

/**
 * GitHub's mark in the ink colour, shaped as an icon so a table of icons (Add project's sources,
 * a repository's row) can hold it beside ace's own glyphs.
 */
export const GithubGlyph: IconGlyph = (props) => {
  const asked = typeof props.size === "number" ? props.size : 16;
  const size = brandSizes.reduce((best, each) =>
    Math.abs(each - asked) < Math.abs(best - asked) ? each : best,
  );
  return (
    <ForgeIcon forge="github" size={size} variant="mono" decorative className={props.className} />
  );
};
