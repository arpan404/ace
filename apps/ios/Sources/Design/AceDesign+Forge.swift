import SwiftUI

/// Tokens the pull request, files, changes and tool views need beyond the core design file.
/// Same rules: views name these, never the numbers.

extension AceDesign.Space {
    /// Where a full page's empty, failed or loading state sits below its header.
    static let pageState: CGFloat = 120
    /// The same inside one part of a page (a diff, a comparison).
    static let partState: CGFloat = 64
    /// One level of a file tree: each level's name starts this far past its parent's.
    static let treeLevel: CGFloat = 16
}

extension AceDesign.Size {
    /// A row with a title and a meta line under it.
    static let rowDetail: CGFloat = 52
    /// A glyph inside a meta line or a pill.
    static let metaIcon: CGFloat = 14
    /// A disclosure caret or a chevron.
    static let caret: CGFloat = 12
    /// The column a row's leading glyph sits in, so the names beside it line up.
    static let rowGlyph: CGFloat = 24
    /// A pill drawn smaller than its 44pt tap (a reaction, a toolbar toggle, a panel tab).
    static let pill: CGFloat = 28
    /// A pull request or issue label: a capsule one caption line tall.
    static let label: CGFloat = 18
    /// An unread dot or a modified-file dot.
    static let dot: CGFloat = 6
    /// The side panel's drag handle.
    static let handleWidth: CGFloat = 4
    static let handleHeight: CGFloat = 36
    /// A hairline: a divider, a diff's comment rail, the image-diff split.
    static let hairline: CGFloat = 1
    static let rail: CGFloat = 2
    /// A drawn glyph's stroke (a file-status box).
    static let glyphStroke: CGFloat = 1.5
    /// The space a floating bar takes at the bottom of a scrolling page, so the last row clears it.
    static let floatingBarClearance: CGFloat = 72
    /// A fixed editor that holds a few lines of instructions.
    static let editorHeight: CGFloat = 220
    /// A chip whose text is cut before it pushes its neighbours off the row.
    static let chipMaxWidth: CGFloat = 96
}

extension AceDesign.Typeface {
    /// A page's own heading inside its content (the new thread's question).
    static let hero = Font.title
}

@MainActor extension AceDesign.Surface {
    /// A quiet band on the page: a diff's hunk header, a folded run of lines.
    static var band: Color { AceTheme.Colours.fill.opacity(0.5) }
    /// The lines a person picked in a diff.
    static var picked: Color { AceTheme.Colours.accent.opacity(0.16) }
    /// The line a person jumped to in a file.
    static var lineHighlight: Color { AceTheme.Colours.foreground.opacity(0.07) }
    /// The chosen item in a glass choice row.
    static func chosen(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? AceTheme.Colours.foreground.opacity(0.16) : AceTheme.Colours.glass
    }
}

extension AceDesign.Ink {
    /// A forge label's own colour, behind its words.
    static let labelFillOpacity: Double = 0.2
}
