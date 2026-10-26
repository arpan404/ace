import CoreGraphics

/// How tall the composer's text is. Unfocused, it is as tall as its text (one line when empty).
/// Focused, it opens to a writing height of a few lines so there is room to write; text taller
/// than that keeps its own height. Nothing grows past `maxLines`, where the text scrolls.
struct ComposerFit: Equatable {
    /// One line of text at the current type size.
    let line: CGFloat
    /// The text view's top and bottom insets together.
    let inset: CGFloat
    /// The one-line composer's height: a touch target.
    let minimum: CGFloat
    /// Accessibility type sizes open to fewer lines, so the writing height leaves room for the
    /// transcript above the keyboard.
    var largeType = false

    static let writingLines: CGFloat = 3
    static let largeTypeWritingLines: CGFloat = 2
    static let maxLines: CGFloat = 5

    var maximum: CGFloat { max(minimum, line * Self.maxLines + inset) }
    var writing: CGFloat { min(maximum, max(minimum, line * (largeType ? Self.largeTypeWritingLines : Self.writingLines) + inset)) }

    /// The text view's height for text that needs `content` points.
    func height(content: CGFloat, focused: Bool) -> CGFloat {
        let own = min(max(content, minimum), maximum)
        return focused ? max(own, writing) : own
    }

    /// The composer lays out as a card (the text on its own rows, the controls on a row below)
    /// while it is focused or its text wraps; otherwise everything sits on one line.
    static func card(focused: Bool, wraps: Bool) -> Bool { focused || wraps }
}
