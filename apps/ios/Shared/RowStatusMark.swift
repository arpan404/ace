import SwiftUI

/// A thread's status mark, the desktop row's set (`rowStatusLook`, `status-icons.tsx`) in ace's
/// own icons and the web's weights (filled, the working ring bold), shared by the app's rows
/// (`RowStatusIcon`) and the widgets and Live Activity, so the lock screen draws exactly what the
/// inbox draws. Needs a model a sparkle, approval a raised hand,
/// question a question mark, failed a warning circle, working a dashed circle, waiting on agents
/// the dashed circle holding the count, any other wait a countdown clock, a usage limit a gauge
/// (muted, no timer), background work a terminal, finished and unseen a check circle. Still,
/// never animated. Decorative: what it sits in says the meaning for VoiceOver.
struct RowStatusMark: View {
    let kind: String
    let tone: String
    var count: Int? = nil
    /// The point size, already scaled by the caller where Dynamic Type applies.
    let size: CGFloat
    /// The count inside the waiting ring, and the dot that stands in above nine: parts of the
    /// glyph's drawing, as fractions of its size.
    private static let countScale: CGFloat = 0.56
    private static let moreDot: CGFloat = 0.22
    /// The frame's room around the drawing, as the row's other marks leave.
    private static let overhang: CGFloat = 2
    /// The count's weight (`AceDesign.Typeface.strong`).
    private static let strong = Font.Weight.semibold

    var body: some View {
        Group {
            if kind == "agents" {
                ZStack {
                    Self.drawn(.circleDashed, weight: .bold, size: size)
                    // 1–9 in the ring; above nine, a small dot.
                    if let count, count > 0, count <= 9 {
                        Text(count.formatted()).font(.system(size: size * Self.countScale, weight: Self.strong)).monospacedDigit()
                    } else {
                        Circle().frame(width: size * Self.moreDot, height: size * Self.moreDot)
                    }
                }
            } else if let mark = Self.icon(kind) {
                Self.drawn(mark.name, weight: mark.weight, size: size)
            }
        }
        .foregroundStyle(Self.colour(tone))
        .frame(width: size + Self.overhang, height: size + Self.overhang)
        .accessibilityHidden(true)
    }

    /// The icon and weight for a status, as `status-icons.tsx` draws it.
    static func icon(_ kind: String) -> (name: AceIcon.Name, weight: AceIcon.Weight)? {
        switch kind {
        case "model": (.sparkle, .fill)
        case "approve": (.handPalm, .fill)
        case "question": (.question, .fill)
        case "failed": (.warningCircle, .fill)
        case "working": (.circleDashed, .bold)
        case "waiting": (.clockCountdown, .fill)
        case "limited": (.gauge, .fill)
        case "background": (.terminalWindow, .fill)
        case "done": (.checkCircle, .fill)
        // Back from a snooze that ended by itself, until read.
        case "woke": (.alarm, .fill)
        // The lock screen's needs-you count: the sparkle the desktop's attention mark uses.
        case "sparkle": (.sparkle, .fill)
        default: nil
        }
    }

    /// The icon at `size`, which the caller has already scaled.
    static func drawn(_ icon: AceIcon.Name, weight: AceIcon.Weight, size: CGFloat) -> some View {
        Image(ace: icon, weight: weight).resizable().scaledToFit().frame(width: size, height: size)
    }

    @MainActor static func colour(_ tone: String) -> Color {
        switch tone {
        case "needs-you": AceTheme.RowStatus.needsYou
        case "failed": AceTheme.RowStatus.failed
        case "working": AceTheme.RowStatus.working
        case "waiting": AceTheme.RowStatus.waiting
        case "background": AceTheme.RowStatus.background
        case "finished": AceTheme.RowStatus.finished
        case "woke": AceTheme.Colours.foreground
        // A usage limit and a seen failure take the quiet muted ink.
        default: AceTheme.Colours.mutedForeground
        }
    }
}
