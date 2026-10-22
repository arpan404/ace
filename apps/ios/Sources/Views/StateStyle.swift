import SwiftUI

/// Colours for the shared status token keys (`@ace/ui-core/mobile`), through `AceTone`. Words
/// and grouping arrive ready-made from the bridge; this never labels a state or computes tree
/// completion.
@MainActor enum StateStyle {
    static func marker(_ token: String) -> Color { AceTone(token).mark }
    static func text(_ token: String) -> Color { AceTone(token).text }
}

/// A bridge status (word and token) as a `StatusLabel`: what needs the person is loud, the rest
/// muted with its glyph keeping the hue.
struct StateLabel: View {
    let status: StatusDisplay
    var body: some View {
        let tone = AceTone(status.token)
        StatusLabel(word: status.label, tone: tone,
                    glyph: tone == .idle || tone == .waiting ? nil : GlyphState(tone: tone),
                    loud: StatusSymbol.isLoud(status.token))
    }
}
extension View {
    @ViewBuilder func floatingGlass() -> some View {
        let shape = RoundedRectangle(cornerRadius: AceTheme.Radii.composer)
        if #available(iOS 26, *) { self.glassEffect(.regular, in: shape) }
        else { self.background(.regularMaterial, in: shape).overlay(shape.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border)) }
    }
}
