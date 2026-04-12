import { useEffect } from "react";

import { applyUiTypographyFromSettings } from "~/lib/uiTypography";
import { useSettings } from "~/hooks/useSettings";

/** Keeps document CSS variables in sync with client typography settings. */
export function UiTypographyBridge() {
  const uiFontFamily = useSettings((s) => s.uiFontFamily);
  const uiMonoFontFamily = useSettings((s) => s.uiMonoFontFamily);
  const uiFontSizeScale = useSettings((s) => s.uiFontSizeScale);
  const uiLetterSpacing = useSettings((s) => s.uiLetterSpacing);

  useEffect(() => {
    applyUiTypographyFromSettings({
      uiFontFamily,
      uiMonoFontFamily,
      uiFontSizeScale,
      uiLetterSpacing,
    });
  }, [uiFontFamily, uiMonoFontFamily, uiFontSizeScale, uiLetterSpacing]);

  return null;
}
