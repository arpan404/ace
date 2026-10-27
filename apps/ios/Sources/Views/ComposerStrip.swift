import SwiftUI

/// The surface above the composer (DESIGN.md §8), which on the phone holds only what needs the
/// person: the oldest open request, as a native grouped list on a dark rounded surface. Content
/// past about half the screen scrolls inside it. What is only live (work, subagents, commands, the
/// queue, the goal) is the pill's above it.
struct StripSurface<Content: View>: View {
    var maxHeight: CGFloat = .infinity
    @ViewBuilder var content: () -> Content
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        let shape = AceShape.group
        ScrollView {
            content()
                .padding(.horizontal, AceTheme.Spacing.lg)
                .padding(.top, AceTheme.Spacing.md + AceTheme.Spacing.xxs)
                .padding(.bottom, AceTheme.Spacing.sm)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .containerShape(shape)
        .background(GroupedSurface.colour, in: shape)
        .padding(.horizontal, ReadingColumn.bar(sizeClass).composer)
        .padding(.bottom, AceTheme.Spacing.sm)
    }
}

/// The grouped list's surface: the card colour in dark, a step off the page, and the faint grey in
/// light, where the card would be the page's white.
enum GroupedSurface {
    @MainActor static var colour: Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(AceTheme.Colours.card) : UIColor(AceTheme.Colours.secondaryBackground)
        })
    }
}

enum StripMetrics {
    /// Insets inside the surface (a command, a plan) sit `lg` in from its edge, so their corners
    /// are the surface's less that.
    static let insetRadius = AceShape.nested(in: AceTheme.Radii.composer, inset: AceTheme.Spacing.lg)
}

/// One row of a request's grouped list: a hairline above every row but the first, the name on
/// the left and, where there is one, its value in muted text and a chevron on the right.
struct GroupedRow<Content: View>: View {
    var first = false
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .aceFont(AceTheme.Typography.body, relativeTo: .body)
            .foregroundStyle(AceTheme.Colours.foreground)
            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
            .overlay(alignment: .top) {
                if !first { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border).accessibilityHidden(true) }
            }
            .contentShape(Rectangle())
    }
}

/// The muted value and chevron at a grouped row's trailing end.
struct GroupedValue: View {
    let text: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Text(text).lineLimit(1).foregroundStyle(AceTheme.Colours.mutedForeground)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityHidden(true)
        }
    }
}

/// A small text action inside a request card: "Details". Ghost, a step brighter when pressed.
/// `prominent` is the strip's way on that carries the work on ("Continue"): full ink, a step bolder.
struct StripTextButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(prominent ? .semibold : .medium)
            .foregroundStyle(configuration.isPressed || prominent ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .contentShape(Rectangle())
    }
}
