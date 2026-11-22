import SwiftUI

/// The bar's places with their selection drawn in Liquid Glass, as the system's iOS 26 tab bar
/// draws it (`GlidingPlaces` decides where it sits). At rest a glass pill tinted with the chosen
/// fill sits behind the chosen place. While a finger is down that pill morphs into a clear,
/// interactive lens over the places, swollen a little (`AceDesign.Motion.tabLift`), showing the
/// places under it magnified (`tabLens`); lifted, the lens morphs back into the pill. Both shapes
/// share one glass id in one container, so the system morphs one into the other instead of
/// fading. The magnified places are a copy hidden from VoiceOver and touches.
@available(iOS 26, *)
struct GlassPlaces<Row: View, Lens: View>: View {
    let row: Row
    /// The places again, drawn magnified inside the lens.
    let lens: Lens
    /// One place's width, the row's, and the selection's leading edge along it.
    let slot: CGFloat
    let width: CGFloat
    let offset: CGFloat
    let pressed: Bool
    /// The chosen place, so a place chosen elsewhere glides there too.
    let chosen: Int
    @Namespace private var glass

    private static var id: String { "selection" }

    var body: some View {
        GlassEffectContainer(spacing: AceTheme.Spacing.none) {
            row
                .background(alignment: .leading) {
                    if !pressed {
                        AceShape.capsule.fill(.clear)
                            .frame(width: slot)
                            .glassEffect(.regular.tint(AceDesign.Surface.fill), in: AceShape.capsule)
                            .glassEffectID(Self.id, in: glass)
                            .offset(x: offset)
                    }
                }
                .overlay(alignment: .leading) {
                    if pressed {
                        magnified
                            .glassEffect(.regular.interactive(), in: AceShape.capsule)
                            .glassEffectID(Self.id, in: glass)
                            .scaleEffect(AceDesign.Motion.tabLift)
                            .offset(x: offset)
                    }
                }
        }
        .animation(AceDesign.Motion.tabSettle, value: chosen)
    }

    /// The places under the lens, scaled about its centre and cut to its shape: the copy is laid
    /// out at the row's width, moved so it lines up with the row beneath, then magnified.
    private var magnified: some View {
        lens
            .frame(width: width)
            .offset(x: -offset)
            .frame(width: slot, alignment: .leading)
            .scaleEffect(AceDesign.Motion.tabLens)
            .clipShape(AceShape.capsule)
            .allowsHitTesting(false)
    }
}
