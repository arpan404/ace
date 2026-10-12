# Shared ace design tokens

`tokens.json` is the source for Android and iOS themes. The values follow the approved
mobile v2 mockup. Status marker colours match the light/dark `statusSets` in the web presets,
including unresponsive pink. A parity test compares all twelve values with the rendered
web presets so CI catches drift. Colour describes daemon state; tokens never derive status.

```ts
import { designTokens } from "@ace/design-tokens";
const theme = designTokens.schemes.dark;
```

The TypeScript export validates the JSON with Zod and freezes every object. There is
no filesystem, platform, clock, colour generation or UI code in this package.
Native generators read `@ace/design-tokens/tokens.json`, or the repository file
`packages/design-tokens/tokens.json`. Do not maintain a second palette in generated Swift
or Kotlin. Commit generator output only with a reproducibility check against this source.

Dimensions use logical points on iOS and dp on Android. Typography uses scalable points
or sp, including line height. Motion durations use milliseconds. Easing arrays are cubic
Bezier control points. Radii, elevation and ripple opacity are explicit so native themes
can turn off OEM defaults and dynamic colour. Respect reduced motion and system text scale.
The pill radius is capped by half the component height. Glass opacity is optional to render;
use the opaque card colour when transparency is unavailable or reduced.

Bundle Inter and JetBrains Mono under their SIL Open Font Licenses in each app. Family
names here are design requirements, not font downloads or a fallback to system fonts.
Fonts and native theme mappings belong to the apps. Bump `version` for incompatible
token changes. Additive values require matching updates to the strict schema.

Use `foreground`, `mutedForeground`, `subtleForeground`, `accent` and `statusText` for
normal-sized text on any of the eight content surfaces. Every permitted pair meets
WCAG AA 4.5:1. `onAccent` is text on the accent action surface only. `status` colours
are marker/dot colours; they are not a text palette. Use `statusText` for a matching
status label. `decoration` is for non-text glyphs and meets 3:1 on the content surfaces.
`separator`, `scrim` and `shadow` are decorative layers, never text or content surfaces.
Disabled controls use their own reduced opacity and must not carry required information.

The contrast tests cover every permitted text/surface pair, the accent action, and
decorative glyphs. Native generators must validate raw JSON with `DesignTokensSchema`
before emitting Swift or Kotlin. The raw JSON validity test also protects generators
that read the file directly. There are no generators in this data-only package.

The native light accent is `#3065CC`, slightly darker than web's `#3269D4`, so
normal accent text also meets 4.5:1 on the mobile deletion surface `#FDECEC`.
