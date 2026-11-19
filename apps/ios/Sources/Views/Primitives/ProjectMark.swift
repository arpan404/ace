import SwiftUI

/// A project's mark on a row, by the web's row rule (`projectMark` in `@ace/ui-core`): the
/// person's own image or the found favicon, greyed; else the glyph they chose, else the shared
/// initials, in muted ink on the quiet fill. Identity is monochrome in lists, so the colour shows
/// only where the mark names the place the person is in: with a `tint` (the thread's title) it is
/// drawn as the web draws it, the image in its own colours and the glyph or initials in the
/// project's tint on a wash of it. A chat (ADR 0099) wears a speech bubble. `quiet` (settled rows)
/// recedes it. Decorative: the project name sits beside it.
struct ProjectMark: View {
    let initials: String
    var chat = false
    var look: ProjectMarkLook? = nil
    var quiet = false
    /// The project's colour, for a mark drawn as the web draws it; nil keeps it in ink.
    var tint: Color? = nil
    @ScaledMetric(relativeTo: .caption2) private var height: CGFloat = AceDesign.Size.icon
    @ScaledMetric(relativeTo: .caption2) private var width: CGFloat = AceDesign.Size.icon + AceDesign.Space.tight
    /// The mark's own drawing: glyphs and initials sized to sit inside its 16pt tile.
    static let glyphSize: CGFloat = 13
    static let tileGlyphSize: CGFloat = 11
    static let initialsScale: CGFloat = 0.6

    init(initials: String, chat: Bool = false, look: ProjectMarkLook? = nil, quiet: Bool = false, tint: Color? = nil,
         size: CGFloat = AceDesign.Size.icon) {
        self.initials = initials
        self.chat = chat
        self.look = look
        self.quiet = quiet
        self.tint = tint
        _height = ScaledMetric(wrappedValue: size, relativeTo: .caption2)
        _width = ScaledMetric(wrappedValue: size + AceDesign.Space.tight * size / AceDesign.Size.icon, relativeTo: .caption2)
    }

    /// The tile's drawing scales with its height; 16pt is the size the glyph constants are for.
    private var unit: CGFloat { height / AceDesign.Size.icon }

    var body: some View {
        Group {
            if chat {
                AceIcon(.chatCircle, size: ProjectMark.glyphSize * unit, weight: .bold, relativeTo: .caption2).foregroundStyle(ink)
            } else if let artwork = look?.artwork, artwork.state != .failed {
                ProjectArtworkMark(artwork: artwork, quiet: quiet, coloured: tint != nil && !quiet)
            } else {
                tile
            }
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }

    private var ink: Color {
        if quiet { return AceDesign.Ink.faint }
        return tint ?? AceDesign.Ink.muted
    }
    private var fill: Color {
        if let tint, !quiet { return tint.opacity(AceDesign.Ink.projectWash) }
        return AceDesign.Surface.fill
    }

    /// The glyph or initials on the quiet fill, also what a failed image falls back to.
    private var tile: some View {
        Group {
            if let glyph = look?.glyph {
                AceIcon(glyph, size: ProjectMark.tileGlyphSize * unit, weight: .bold, relativeTo: .caption2)
            } else if initials.isEmpty {
                // Rows that show no initials keep the project's folder.
                AceIcon(.folderSimple, size: ProjectMark.glyphSize * unit, relativeTo: .caption2)
            } else {
                Text(initials.uppercased())
                    .font(.system(size: height * ProjectMark.initialsScale, weight: AceDesign.Typeface.strong))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .foregroundStyle(ink)
        .frame(width: width, height: height)
        .background(initials.isEmpty && look?.glyph == nil ? .clear : fill, in: AceDesign.Shape.control)
    }
}

extension ProjectMark {
    /// The mark as a picture, for a system menu row that draws only images: the same mark in the
    /// same colours, for the appearance it is drawn in.
    @MainActor static func image(initials: String, look: ProjectMarkLook?, tint: Color?, scheme: ColorScheme) -> UIImage? {
        let mark = ProjectMark(initials: initials, look: look, tint: tint, size: AceDesign.Size.barIcon)
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: mark)
        renderer.scale = UITraitCollection.current.displayScale
        return renderer.uiImage?.withRenderingMode(.alwaysOriginal)
    }
}

/// The web's twelve project tints (`--project-1` to `--project-12` in its theme), light then
/// dark: one hue each around the wheel at one lightness per scheme. A project's tint stays with
/// its id (`projectBadge` in `@ace/ui-core` sends which); a colour the person chose maps to one
/// of them as the web's account colours do.
@MainActor enum ProjectTint {
    private static let tints: [(UInt32, UInt32)] = [
        (0x861D1F, 0xFEBAB4), (0x723902, 0xFFBE92), (0x5E4608, 0xF2C86C), (0x3E5305, 0xBCDC83),
        (0x065A27, 0x93E4A4), (0x01574A, 0x67E7CE), (0x00555C, 0x59E4F3), (0x085076, 0x9ED5FD),
        (0x2A4195, 0xBACDFD), (0x52348D, 0xD1C4FD), (0x6E2773, 0xF6B2F9), (0x801D4E, 0xFEB6D1),
    ]
    /// Tint `index`, 1 to 12; nil outside them.
    static func colour(_ index: Int) -> Color? {
        guard tints.indices.contains(index - 1) else { return nil }
        let (light, dark) = tints[index - 1]
        return adaptive(light, dark)
    }
    /// A chosen badge colour as the web draws it (`accountColors`): ink for neutral, else its tint.
    static func chosen(_ key: String) -> Color? {
        switch key {
        case "neutral": AceDesign.Ink.primary
        case "blue": colour(8)
        case "green": colour(5)
        case "amber": colour(2)
        case "rose": colour(12)
        case "violet": colour(10)
        default: nil
        }
    }
    /// The project's colour: the one the person chose, else the tint that stays with its id.
    static func of(look: ProjectMarkLook?, tint: Int?) -> Color? {
        look?.color.flatMap(chosen) ?? tint.flatMap(colour)
    }
    /// UIKit resolves dynamic colours on render threads too, so this touches nothing isolated.
    nonisolated private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { @Sendable traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

/// A project image: the quiet fill while it decodes or loads, then the image, greyed in lists and
/// in its own colours where the mark is `coloured`.
private struct ProjectArtworkMark: View {
    let artwork: ProjectArtwork
    let quiet: Bool
    var coloured = false
    var body: some View {
        Group {
            if let image = artwork.image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(AceDesign.Shape.control)
                    .grayscale(coloured ? 0 : 1)
                    .opacity(quiet ? AceDesign.Ink.recede : 1)
            } else {
                AceDesign.Shape.control.fill(AceDesign.Surface.fill)
            }
        }
        .onAppear { artwork.load() }
    }
}
