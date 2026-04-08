const PRODUCTION_ICON_ROOT = "assets/prod/icons";
const DEVELOPMENT_ICON_ROOT = "assets/dev/icons";

export const BRAND_ASSET_PATHS = {
  productionMacIconPng: `${PRODUCTION_ICON_ROOT}/png/1024x1024.png`,
  productionLinuxIconPng: `${PRODUCTION_ICON_ROOT}/png/1024x1024.png`,
  productionWindowsIconIco: `${PRODUCTION_ICON_ROOT}/win/icon.ico`,
  productionWebFaviconIco: `${PRODUCTION_ICON_ROOT}/win/icon.ico`,
  productionWebFavicon16Png: `${PRODUCTION_ICON_ROOT}/png/16x16.png`,
  productionWebFavicon32Png: `${PRODUCTION_ICON_ROOT}/png/32x32.png`,
  productionWebAppleTouchIconPng: `${PRODUCTION_ICON_ROOT}/png/512x512.png`,
  developmentWindowsIconIco: `${DEVELOPMENT_ICON_ROOT}/win/icon.ico`,
  developmentWebFaviconIco: `${DEVELOPMENT_ICON_ROOT}/win/icon.ico`,
  developmentWebFavicon16Png: `${DEVELOPMENT_ICON_ROOT}/png/16x16.png`,
  developmentWebFavicon32Png: `${DEVELOPMENT_ICON_ROOT}/png/32x32.png`,
  developmentWebAppleTouchIconPng: `${DEVELOPMENT_ICON_ROOT}/png/512x512.png`,
} as const;

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export const DEVELOPMENT_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];

export const PUBLISH_ICON_OVERRIDES: ReadonlyArray<IconOverride> = [
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
];
