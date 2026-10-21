import SwiftUI
import UIKit

/// The ace mark: two mirrored wings around an open diamond, on the mark's 24 × 22 grid
/// (the same outline as the app icon and the web's mark).
struct AceMark: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / 24, rect.height / 22)
        let origin = CGPoint(x: rect.midX - 12 * scale, y: rect.midY - 11 * scale)
        var path = Path()
        for mirrored in [false, true] {
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: origin.x + (mirrored ? 24 - x : x) * scale, y: origin.y + y * scale)
            }
            path.move(to: p(11.6, 2))
            path.addCurve(to: p(9.8, 3.3), control1: p(10.8, 2), control2: p(10.4, 2.6))
            path.addLine(to: p(2.9, 11.3))
            path.addCurve(to: p(3.8, 16.8), control1: p(1.2, 13.3), control2: p(1.8, 15.6))
            path.addLine(to: p(7.8, 19.3))
            path.addCurve(to: p(9.9, 19.1), control1: p(8.5, 19.8), control2: p(9.3, 19.8))
            path.addLine(to: p(11, 17.7))
            path.addCurve(to: p(10.8, 15.4), control1: p(11.7, 16.8), control2: p(11.5, 16.1))
            path.addLine(to: p(7.3, 12.3))
            path.addCurve(to: p(11.6, 5), control1: p(10.3, 9.8), control2: p(11.6, 7.6))
            path.closeSubpath()
        }
        return path
    }
}

/// A provider's brand mark from the generated `ProviderMarks` assets (`provider-<kind>`), or
/// ace's neutral agent glyph for a provider with no mark. Decorative: rows name the provider
/// elsewhere for VoiceOver.
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 15
    var body: some View {
        Group {
            if UIImage(named: "provider-\(provider)") != nil {
                Image("provider-\(provider)").resizable().scaledToFit()
            } else {
                Image(systemName: "sparkle").resizable().scaledToFit().padding(size * 0.1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The project's initial as a quiet monogram: a faint tile the size of the name's cap height,
/// so it reads as part of the line rather than a badge. Decorative; the name beside it speaks.
struct ProjectMark: View {
    let badge: String
    @ScaledMetric(relativeTo: .subheadline) private var side: CGFloat = 16
    var body: some View {
        Text(badge.prefix(1).uppercased())
            .font(.system(size: side * 0.6, weight: .semibold, design: .rounded))
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(width: side, height: side)
            .background(AceTheme.Colours.mutedForeground.opacity(0.16), in: RoundedRectangle(cornerRadius: side * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}
