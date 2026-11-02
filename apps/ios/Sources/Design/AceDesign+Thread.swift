import SwiftUI

/// The few values the inbox, the thread and the composer need beyond `AceDesign.swift`. Same
/// rule: views name one of these, never a number of their own.

extension AceDesign.Size {
    /// A glyph beside meta or caption words: a caret, a clock, a fork.
    static let glyphSmall: CGFloat = 12
    /// A glyph beside a quiet line of body words: stop, paperclip, a machine, a file.
    static let glyphMeta: CGFloat = 14
    /// The column a transcript line's lead icon sits in, so every line's words start together.
    static let lead: CGFloat = 20
}
