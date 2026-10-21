import SwiftUI

/// A status tone (DESIGN.md §5 "Colour means state") and its two colours: `mark` for glyphs
/// and dots, `text` for words. The key arrives from the bridge, either as the shared `Tone`
/// (`needs-you`) or the mobile token (`needsYou`); Swift only maps it to the theme.
enum AceTone: Equatable, Sendable {
    case working, needsYou, waiting, failed, done, unresponsive, background, idle

    init(_ key: String) {
        switch key {
        case "working": self = .working
        case "needs-you", "needsYou": self = .needsYou
        case "waiting": self = .waiting
        case "failed": self = .failed
        case "done": self = .done
        case "unresponsive": self = .unresponsive
        case "background": self = .background
        default: self = .idle
        }
    }

    /// The hue for glyphs and dots. Background work is neutral ink, never the working colour;
    /// idle is the subtle tier.
    @MainActor var mark: Color {
        switch self {
        case .working: AceTheme.Status.working
        case .needsYou: AceTheme.Status.needsYou
        case .waiting: AceTheme.Status.waiting
        case .failed: AceTheme.Status.failed
        case .done: AceTheme.Status.done
        case .unresponsive: AceTheme.Status.unresponsive
        case .background: AceTheme.Colours.mutedForeground
        case .idle: AceTheme.Colours.subtleForeground
        }
    }

    /// The hue for words, AA on every surface.
    @MainActor var text: Color {
        switch self {
        case .working: AceTheme.StatusText.working
        case .needsYou: AceTheme.StatusText.needsYou
        case .waiting: AceTheme.StatusText.waiting
        case .failed: AceTheme.StatusText.failed
        case .done: AceTheme.StatusText.done
        case .unresponsive: AceTheme.StatusText.unresponsive
        case .background: AceTheme.Colours.mutedForeground
        case .idle: AceTheme.Colours.subtleForeground
        }
    }
}

extension AceTheme.Colours {
    /// The fourth text tier (DESIGN.md §2): decorative icons and carets, never words.
    static var faintForeground: Color { decoration }
}
