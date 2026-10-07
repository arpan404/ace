/** Selection facts contain no paths or filesystem operations. */
export type HomeLayout = "empty" | "rewrite" | "unknown" | "incompatible";
export function selectDefaultHome(facts: { isolated: HomeLayout; isolatedMarker: boolean }): void {
  if (facts.isolatedMarker) {
    if (facts.isolated === "incompatible") throw new Error("Incompatible isolated ace home");
    return;
  }
  if (facts.isolated === "unknown" || facts.isolated === "incompatible")
    throw new Error("Unrecognized data in isolated ace home; choose an empty ACE_HOME");
}
