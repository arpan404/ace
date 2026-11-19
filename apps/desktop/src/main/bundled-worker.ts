/**
 * Where a worker bundle written beside the main bundle (`scripts/common.ts`) loads from, given
 * the main bundle's URL. Electron reads the archive for the main process, but a worker's module
 * loader does not, so worker bundles are kept unpacked beside it (`asarUnpack`).
 */
export function bundledWorkerUrl(mainUrl: string, bundle: string): URL {
  const url = new URL(`./${bundle}`, mainUrl);
  url.pathname = url.pathname.replace(/\/app\.asar\//, "/app.asar.unpacked/");
  return url;
}
