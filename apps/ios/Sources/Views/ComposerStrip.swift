import SwiftUI

/// The composer's one strip (DESIGN.md §8), which on the phone holds only what needs the person: the
/// oldest open request. The composer's material on a slightly narrower card, its lower edge tucked
/// behind the composer's top edge. Its glass stops at that edge, so the two never blur one another.
/// Content past about half the screen scrolls inside it. What is only live (work, subagents,
/// commands, the queue, the goal) is the pill's above it.
struct StripSurface<Content: View>: View {
    var maxHeight: CGFloat = .infinity
    @ViewBuilder var content: () -> Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        let shape = AceShape.strip
        ScrollView {
            content()
                .padding(.horizontal, AceTheme.Spacing.lg)
                .padding(.top, AceTheme.Spacing.md)
                .padding(.bottom, AceTheme.Spacing.md + StripMetrics.tuck)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .aceContainerShape(shape)
        .composerGlass(in: shape)
        .shadow(color: AceTheme.Colours.shadow.opacity(AceTheme.Opacity.shadow(scheme) / 2), radius: AceTheme.Spacing.sm, y: -AceTheme.Dimensions.border)
        .mask(alignment: .top) {
            // The glass and its shadow end at the composer's edge.
            GeometryReader { box in
                let bleed = AceTheme.Spacing.xl
                Rectangle()
                    .frame(width: box.size.width + bleed * 2, height: max(AceTheme.Spacing.none, box.size.height - StripMetrics.tuck) + bleed)
                    .offset(x: -bleed, y: -bleed)
            }
        }
        .padding(.horizontal, ReadingColumn.bar(sizeClass).card)
        .padding(.bottom, -StripMetrics.tuck)
    }
}

enum StripMetrics {
    /// The composer and its strip share the composer radius: a capsule while one line tall.
    static let radius = AceTheme.Radii.composer
    /// Insets inside the strip or composer (a command, a plan, a choice) sit `lg` in from its
    /// edge, so their corners are the composer's less that.
    static let insetRadius = AceShape.nested(in: radius, inset: AceTheme.Spacing.lg)
    /// How far the strip's lower edge sits behind the composer.
    static let tuck = AceTheme.Spacing.lg
}

/// A small text action inside a request card: "Details". Ghost, a step brighter when pressed.
struct StripTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
            .foregroundStyle(configuration.isPressed ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .contentShape(Rectangle())
    }
}
