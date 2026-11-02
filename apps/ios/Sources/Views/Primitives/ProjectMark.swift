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
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = AceDesign.Size.icon
    @ScaledMetric(relativeTo: .caption2) private var width: CGFloat = AceDesign.Size.icon + AceDesign.Space.tight
    /// The mark's own drawing: glyphs and initials sized to sit inside its 16pt tile.
    static let glyphSize: CGFloat = 13
    static let tileGlyphSize: CGFloat = 11
    static let initialsScale: CGFloat = 0.6

    var body: some View {
        Group {
            if chat {
                AceIcon(.chatCircle, size: ProjectMark.glyphSize, weight: .bold, relativeTo: .caption2).foregroundStyle(ink)
            } else if let artwork = look?.artwork, artwork.state != .failed {
                ProjectArtworkMark(artwork: artwork, quiet: quiet)
            } else {
                tile
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }

    private var ink: Color { quiet ? AceDesign.Ink.faint : AceDesign.Ink.muted }

    /// The glyph or initials on the quiet fill, also what a failed image falls back to.
    private var tile: some View {
        Group {
            if let glyph = look?.glyph {
                AceIcon(glyph, size: ProjectMark.tileGlyphSize, weight: .bold, relativeTo: .caption2)
            } else {
                Text(initials.uppercased())
                    .font(.system(size: height * ProjectMark.initialsScale, weight: AceDesign.Typeface.strong))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundStyle(ink)
        .frame(width: width, height: height)
        .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
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
                    .clipShape(AceDesign.Shape.control)
                    .grayscale(1)
                    .opacity(quiet ? AceDesign.Ink.recede : 1)
            } else {
                AceDesign.Shape.control.fill(AceDesign.Surface.fill)
            }
        }
        .onAppear { artwork.load() }
    }
}
