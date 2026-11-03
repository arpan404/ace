import SwiftUI

extension EnvironmentValues {
    /// Inside the composer's glass block: surfaces draw a quiet fill instead of their own glass
    /// (no glass on glass), and the strip and composer leave the block's edges to it.
    @Entry var inGlassBlock = false
}

/// The strip and the composer as one glass object above the keyboard (DESIGN.md: one material):
/// the strip is the block's top section, a hairline, then the composer's row, in one 26pt
/// continuous shape with a soft shadow, as the approved mockup draws it.
struct GlassBlock: ViewModifier {
    let active: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass
    static let inset = AceTheme.Spacing.none
    /// The block's side inset on a phone; a wider window keeps its reading column.
    static func side(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat {
        sizeClass == .regular ? ReadingColumn.bar(sizeClass).composer : AceDesign.Space.dockSide
    }
    func body(content: Content) -> some View {
        if active {
            let bar = ReadingColumn.bar(sizeClass)
            let shape = RoundedRectangle(cornerRadius: AceDesign.Size.blockCorner, style: .continuous)
            content
                .environment(\.inGlassBlock, true)
                .aceGlass(in: shape)
                .floatingShadow()
                .padding(.horizontal, Self.side(sizeClass))
                .padding(.bottom, bar.bottom)
        } else {
            content
        }
    }
}

/// The hairline between the block's strip and its composer row.
struct BlockHairline: View {
    var body: some View {
        Rectangle().fill(AceTheme.Colours.separator)
            .frame(height: AceTheme.Dimensions.border / 2)
            .padding(.horizontal, AceDesign.Space.margin)
            .accessibilityHidden(true)
    }
}
