import SwiftUI

/// Tokens the Settings, Devices, Browser, Machines and Projects screens need beyond the core
/// design file. Same rules: views name these, never a number of their own.

extension AceDesign.Ink {
    /// Words and glyphs on the accent's fill (the chosen segment, a primary button).
    static var onAccent: Color { AceTheme.Colours.onAccent }
    /// How far a quiet thing (a settled row's mark, an unchosen preview) recedes.
    static let recede: Double = 0.5
}

extension AceDesign.Surface {
    /// The dim behind a field raised over the page (the browser's address editor).
    static var scrim: Color { Color.black.opacity(0.25) }
}

extension AceDesign.Size {
    /// A place's mark beside its name at the head of its page (a provider's page).
    static let headerMark: CGFloat = 36
    /// A provider mark or avatar leading a two-line row.
    static let avatar: CGFloat = 28
    /// A colour you pick (an accent, a badge's colour): small enough for a row of nine, ringed
    /// inside a 44pt target.
    static let swatch: CGFloat = 28
    /// The ring around a chosen swatch.
    static let ring: CGFloat = 2
    /// A short number field (days, megabytes): room for four digits.
    static let numberField: CGFloat = 64
    /// A chart's legend dot, and the thickness of a bar that shares its colours.
    static let legendDot: CGFloat = 8
    /// A QR code shown to scan: big enough for a camera across a desk.
    static let qrCode: CGFloat = 240
    /// The widest an empty state's words run, so a sentence breaks where it reads well.
    static let emptyWidth: CGFloat = 360
    /// The widest a lone action under an empty state runs.
    static let loneAction: CGFloat = 200
    /// The widest a full-page notice (a page that failed to load) runs.
    static let noticeWidth: CGFloat = 480
    /// The widest a page's content runs on a large screen (Usage on an iPad).
    static let readable: CGFloat = 720
    /// A slim capsule at the system segmented control's height, inside a 44pt tap area.
    static let slimControl: CGFloat = 32
}

extension AceDesign.Motion {
    /// A press answers at once.
    static let press = Animation.easeOut(duration: 0.1)
    /// How far a pressed row gives under the finger.
    static let pressScale: CGFloat = 0.98
}
