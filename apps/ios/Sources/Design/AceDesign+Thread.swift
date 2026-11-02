import SwiftUI
import UIKit

/// The few values the inbox, the thread and the composer need beyond `AceDesign.swift`. Same
/// rule: views name one of these, never a number of their own.

extension AceDesign.Size {
    /// A glyph beside meta or caption words: a caret, a clock, a fork.
    static let glyphSmall: CGFloat = 12
    /// A glyph beside a quiet line of body words: stop, paperclip, a machine, a file.
    static let glyphMeta: CGFloat = 14
    /// The box a bar-size glyph sits in, so the words beside or under a column of glyphs line up.
    static let glyphBox: CGFloat = 24
    /// The column a transcript line's or a row's lead icon sits in, so every line's words start
    /// together.
    static let lead: CGFloat = 20
    /// The Stop square inside Send/Stop.
    static let stopGlyph: CGFloat = 10
    /// The round backing behind a small glyph laid on a picture (remove on a thumbnail).
    static let badge: CGFloat = 20
    /// The dot that marks a row or a tab that needs the person.
    static let dot: CGFloat = 8
    /// A step's running dot on the step rail: smaller than a row's, it sits in a line of meta.
    static let dotSmall: CGFloat = 6
    /// A places-bar tab: room for its word at caption size with the chosen capsule around it.
    static let tab: CGFloat = 88
    /// A popover beside a message or a row (the message menu, a thread's preview, the thread
    /// menu): a reading column's width, never the screen's.
    static let popover: CGFloat = 340
    /// The most a popover widens to where the screen has room (the thread menu on a wide window).
    static let popoverWide: CGFloat = 380
    /// The tallest a popover grows before it scrolls.
    static let popoverHeight: CGFloat = 360
    /// The tallest a folded output (a command's log, a tool's result, a diff) shows before it
    /// scrolls.
    static let foldedOutput: CGFloat = 288
}

extension AceDesign.Space {
    /// How far the page fades out above a bar pinned to the bottom.
    static let fade: CGFloat = 20
    /// A toast's clearance above the places bar: the bar's height and a gap.
    static let aboveTabBar: CGFloat = 76
}

extension AceDesign.Surface {
    /// Behind full-screen photos and video: black in every theme, as the system's own viewers.
    static let media = Color.black
    /// The page laid over a picture so a word or glyph on it reads ("+3", remove).
    static var veil: Color { AceTheme.Colours.background.opacity(veilStrength) }
    /// Code inside the person's bubble: the page showing through, one step back from the bubble.
    static var nested: Color { AceTheme.Colours.background.opacity(nestedStrength) }
    nonisolated static let veilStrength: Double = 0.7
    nonisolated static let nestedStrength: Double = 0.5
}

extension AceDesign.Ink {
    /// Words drawn straight on a picture (a video's length): white with a soft shadow, in
    /// every theme, because the picture decides the background.
    static let onMedia = Color.white
    static let onMediaShadow = Color.black.opacity(0.6)
    nonisolated static let onMediaShadowRadius: CGFloat = 2
    /// A destructive word (Delete, Archive): the system's red, as its menus and alerts draw it.
    static var destructive: Color { Color(uiColor: .systemRed) }
    /// A pressed filled control draws at this strength.
    nonisolated static let pressed: Double = 0.7
    /// A provider mark on a settled row, or quietened: present, one step back.
    nonisolated static let quiet: Double = 0.6
}

extension AceDesign.Motion {
    /// A pressed control shrinks this little, so the press reads without moving the layout.
    static let pressScale: CGFloat = 0.98
    /// A pill grows into place from this scale as it fades in.
    static let arrivalScale: CGFloat = 0.94
    /// Follows the keyboard: the system hands its own duration, ace adds no bounce.
    static func keyboard(_ duration: Double) -> Animation { .spring(duration: duration, bounce: 0) }
}
