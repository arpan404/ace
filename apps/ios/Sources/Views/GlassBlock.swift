import SwiftUI

extension EnvironmentValues {
    /// Inside the composer's glass block: surfaces draw a quiet fill instead of their own glass
    /// (no glass on glass), and the strip and composer leave the block's edges to it.
    @Entry var inGlassBlock = false
}

/// The strip and the composer as one glass object above the keyboard (DESIGN.md: one material):
/// the strip is the block's top section, the composer its bottom, in one shape concentric with
/// the composer's own corners. Without a strip the composer stands alone.
struct GlassBlock: ViewModifier {
    let active: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass
    static let inset = AceTheme.Spacing.xs
    func body(content: Content) -> some View {
        if active {
            let bar = ReadingColumn.bar(sizeClass)
            content
                .environment(\.inGlassBlock, true)
                .padding(Self.inset)
                .aceGlass(in: AceShape.rounded(AceTheme.Radii.composer + Self.inset))
                .padding(.horizontal, bar.composer)
                .padding(.bottom, bar.bottom)
        } else {
            content
        }
    }
}
