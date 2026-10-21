import SwiftUI

/// A provider's bare mark at `size` points (`ProviderMarks.generated.swift`). Brand colours stay
/// where the mark has them; a mono mark takes the surrounding text colour. A provider without a
/// mark draws ace's neutral agent glyph, never a lookalike.
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 18
    var body: some View {
        Group {
            if let asset = ProviderMarks.asset(provider) {
                Image(asset).resizable().scaledToFit()
            } else {
                Image(systemName: "sparkle").resizable().scaledToFit().padding(size * 0.08)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
