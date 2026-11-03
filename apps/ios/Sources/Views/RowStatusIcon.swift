import SwiftUI

/// A thread row's status icon, the desktop row's set (`rowStatusLook`, `status-icons.tsx`) as SF
/// Symbols: needs a model sliders, approval a raised hand, question a question mark, failed a
/// warning circle, working a dashed circle, waiting on agents the dashed circle holding the count,
/// any other wait a countdown clock, a usage limit a gauge (muted, no timer), background work a
/// terminal, finished and unseen a check circle. Each in its state's colour (`RowStatus`, from
/// `@ace/themes`). Still, never animated. Decorative: the row says the meaning for VoiceOver.
struct RowStatusIcon: View {
    let kind: String
    let tone: String
    var count: Int? = nil
    @ScaledMetric private var size: CGFloat
    /// The count inside the waiting ring, and the dot that stands in above nine: parts of the
    /// glyph's drawing, as fractions of its size.
    private static let countScale: CGFloat = 0.56
    private static let moreDot: CGFloat = 0.22
    /// SF Symbols draw a hair past their point size; the frame leaves them that room.
    private static let overhang: CGFloat = 2

    init(kind: String, tone: String, count: Int? = nil, size: CGFloat = AceDesign.Size.icon) {
        self.kind = kind
        self.tone = tone
        self.count = count
        _size = ScaledMetric(wrappedValue: size, relativeTo: .subheadline)
    }

    var body: some View {
        Group {
            if kind == "agents" {
                ZStack {
                    Image(systemName: "circle.dashed").font(.system(size: size, weight: AceDesign.Typeface.strong))
                    // 1–9 in the ring; above nine, a small dot.
                    if let count, count > 0, count <= 9 {
                        Text(count.formatted()).font(.system(size: size * Self.countScale, weight: AceDesign.Typeface.strong)).monospacedDigit()
                    } else {
                        Circle().frame(width: size * Self.moreDot, height: size * Self.moreDot)
                    }
                }
            } else if let symbol = Self.symbol(kind) {
                Image(systemName: symbol).font(.system(size: size, weight: kind == "working" ? AceDesign.Typeface.strong : AceDesign.Typeface.regular))
            }
        }
        .foregroundStyle(Self.colour(tone))
        .frame(width: size + Self.overhang, height: size + Self.overhang)
        .accessibilityHidden(true)
    }

    static func symbol(_ kind: String) -> String? {
        switch kind {
        case "model": "slider.horizontal.3"
        case "approve": "hand.raised.fill"
        case "question": "questionmark.circle.fill"
        case "failed": "exclamationmark.circle.fill"
        case "working": "circle.dashed"
        case "waiting": "timer"
        case "limited": "gauge.with.dots.needle.33percent"
        case "background": "apple.terminal.fill"
        case "done": "checkmark.circle.fill"
        // Back from a snooze that ended by itself, until read.
        case "woke": "alarm.fill"
        default: nil
        }
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
