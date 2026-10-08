export function sensitiveApp(bundle: string): boolean {
  return /(?:1password|bitwarden|lastpass|dashlane|keepass|keeper|enpass|protonpass|password|keychain|systempreferences|systemsettings|terminal|iterm|^dev\.ace\.app(?:\.|$)|^com\.ace\.app(?:\.|$))/i.test(
    bundle,
  );
}

/** Bundle identities, including release channels. Browser computer use is a human UI grant. */
export function browserApp(bundle: string): boolean {
  return /^(?:com\.apple\.Safari(?:TechnologyPreview)?(?:\..*)?|com\.google\.Chrome(?:\..*)?|org\.chromium\.Chromium|org\.mozilla\.(?:firefox|firefoxdeveloperedition|nightly)|company\.thebrowser\.(?:Browser|dia)|com\.brave\.Browser(?:\..*)?|com\.microsoft\.edgemac(?:\..*)?|com\.operasoftware\.(?:Opera|OperaGX)(?:\..*)?|com\.vivaldi\.Vivaldi|app\.zen-browser\.zen|net\.waterfox\.waterfox|org\.torproject\.torbrowser)$/i.test(
    bundle,
  );
}
