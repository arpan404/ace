import rawAppLogoSvg from "../../../assets/prod/icons/logo.svg?raw";

export const APP_LOGO_SVG_MARKUP = rawAppLogoSvg
  .replace(/<\?xml[\s\S]*?\?>/u, "")
  .replace(/<!--[\s\S]*?-->/gu, "")
  .replace(/style="fill:#000000"/u, 'fill="currentColor"')
  .trim();
