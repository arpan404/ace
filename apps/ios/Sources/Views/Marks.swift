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
/// ace's neutral agent glyph for a provider with no mark. When the provider has more than one
/// account, the bridge sends the account's short mark and it sits as an ink bubble on the
/// glyph's bottom-right corner, its outline cut out of the glyph so it reads on any surface (the
/// web's `ProviderAccountIcon`). `quiet` greys and dims it on rows at rest. Decorative: rows
/// name the provider elsewhere for VoiceOver.
struct ProviderMark: View {
    let provider: String
    var account: String? = nil
    var quiet = false
    @ScaledMetric private var size: CGFloat

    init(provider: String, size: CGFloat = 15, account: String? = nil, quiet: Bool = false) {
        self.provider = provider
        self.account = account
        self.quiet = quiet
        _size = ScaledMetric(wrappedValue: size, relativeTo: .caption)
    }

    var body: some View {
        let bubble = (size * 0.75).rounded()
        glyph
            .frame(width: size, height: size)
            .mask {
                // The bubble's outline: a ring of the glyph's own surface around the bubble.
                Rectangle().overlay {
                    if account != nil {
                        Circle().frame(width: bubble + 3, height: bubble + 3)
                            .offset(x: size / 2 - bubble / 2 + 4, y: size / 2 - bubble / 2 + 3)
                            .blendMode(.destinationOut)
                    }
                }
                .compositingGroup()
            }
            .saturation(quiet ? 0 : 1)
            .opacity(quiet ? 0.6 : 1)
            .overlay(alignment: .bottomTrailing) {
                if let account, !account.isEmpty {
                    Text(account.prefix(2))
                        .font(.system(size: bubble * 0.62, weight: .semibold))
                        .minimumScaleFactor(0.6)
                        .foregroundStyle(AceTheme.Colours.background)
                        .frame(width: bubble, height: bubble)
                        .background(AceTheme.Colours.foreground.opacity(quiet ? 0.6 : 1), in: Circle())
                        .offset(x: 4, y: 3)
                }
            }
            .padding(.trailing, account == nil ? 0 : AceTheme.Spacing.xs)
            .accessibilityHidden(true)
    }

    @ViewBuilder private var glyph: some View {
        if UIImage(named: "provider-\(provider)") != nil {
            Image("provider-\(provider)").resizable().scaledToFit()
        } else {
            Image(ace: .sparkle).resizable().scaledToFit()
        }
    }
}
