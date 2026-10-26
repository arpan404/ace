import SwiftUI

/// A project's mark on a row, by the web's row rule (`projectMark` in `@ace/ui-core`): the
/// person's own image or the found favicon, greyed; else the glyph they chose, else the shared
/// initials, in muted ink on the quiet fill. Identity is monochrome, so the chosen colour shows
/// only on the web's large mark. A chat (ADR 0099) wears a speech bubble. `quiet` (settled rows)
/// recedes it. Decorative: the project name sits beside it.
struct ProjectMark: View {
    let initials: String
    var chat = false
    var look: ProjectMarkLook? = nil
    var quiet = false
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = 16
    @ScaledMetric(relativeTo: .caption2) private var width: CGFloat = 20

    var body: some View {
        Group {
            if chat {
                AceIcon(.chatCircle, size: 13, weight: .bold, relativeTo: .caption2).foregroundStyle(ink)
            } else if let artwork = look?.artwork, artwork.state != .failed {
                ProjectArtworkMark(artwork: artwork, quiet: quiet)
            } else {
                tile
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }

    private var ink: Color { quiet ? AceTheme.Colours.faintForeground : AceTheme.Colours.mutedForeground }

    /// The glyph or initials on the quiet fill, also what a failed image falls back to.
    private var tile: some View {
        Group {
            if let glyph = look?.glyph {
                AceIcon(glyph, size: 11, weight: .bold, relativeTo: .caption2)
            } else {
                Text(initials.uppercased())
                    .font(.system(size: height * 0.6, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundStyle(ink)
        .frame(width: width, height: height)
        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.badge, style: .continuous))
    }
}

/// A project image: the quiet fill while it decodes or loads, then the image, greyed.
private struct ProjectArtworkMark: View {
    let artwork: ProjectArtwork
    let quiet: Bool
    var body: some View {
        Group {
            if let image = artwork.image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.badge, style: .continuous))
                    .grayscale(1)
                    .opacity(quiet ? 0.5 : 1)
            } else {
                RoundedRectangle(cornerRadius: AceTheme.Radii.badge, style: .continuous).fill(AceTheme.Colours.fill)
            }
        }
        .onAppear { artwork.load() }
    }
}
