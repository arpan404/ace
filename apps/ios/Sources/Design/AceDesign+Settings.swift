import SwiftUI

/// Tokens the Settings, Devices, Browser, Machines and Projects screens need beyond the core
/// design file. Same rules: views name these, never a number of their own.

extension AceDesign.Ink {
    /// Words and glyphs on the accent's fill (the chosen segment, a primary button).
    static var onAccent: Color { AceTheme.Colours.onAccent }
    /// How far a quiet thing (a settled row's mark, an unchosen preview) recedes.
    static let recede: Double = 0.5
}

extension AceDesign.Size {
    /// A row's leading glyph column: the icon with room for the widest SF Symbol.
    static let glyphColumn: CGFloat = 24
    /// A provider mark or avatar leading a two-line row.
    static let avatar: CGFloat = 28
    /// A swatch you pick (accent, theme): a tap target's worth of colour.
    static let swatch: CGFloat = 32
    /// The camera viewfinder's square while pairing.
    static let viewfinder: CGFloat = 260
    /// The widest an empty state's words run, so a sentence breaks where it reads well.
    static let emptyWidth: CGFloat = 360
    /// The widest a page's text runs on a large screen.
    static let readable: CGFloat = 560
    /// A thumbnail on a row (a device, a screen preview).
    static let thumbnail: CGFloat = 64
}

extension AceDesign.Motion {
    /// A press answers at once.
    static let press = Animation.easeOut(duration: AceTheme.Motion.fast)
    /// How far a pressed row gives under the finger.
    static let pressScale: CGFloat = 0.98
}
