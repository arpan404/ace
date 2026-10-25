import SwiftUI

/// Threads and Pull requests at the foot of the sidebar, where a regular window (iPad, the
/// unfolded iPhone Duo, a large iPhone turned) keeps them instead of the tab bar: one two-way
/// switch, the place showing filled. A compact window has the tab bar back.
struct InboxPlaces: View {
    @Binding var tab: InboxTab
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var fill

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            place("Threads", tab: .threads, id: "sidebar.threads")
            place("Pull requests", tab: .pulls, id: "sidebar.pulls")
        }
        .padding(3)
        .background(AceTheme.Colours.secondaryBackground, in: AceShape.capsule)
        .overlay(AceShape.capsule.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm)
    }

    private func place(_ title: String, tab place: InboxTab, id: String) -> some View {
        let chosen = tab == place
        return Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { tab = place } } label: {
            Text(title)
                .aceFont(AceTheme.TypeStyle(size: 14, lineHeight: 19, weight: 600, tracking: 0), relativeTo: .subheadline)
                .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget - 6)
                .background {
                    if chosen { AceShape.capsule.fill(AceTheme.Colours.fill).matchedGeometryEffect(id: "place", in: fill) }
                }
                .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

extension View {
    /// A bar along the sidebar's foot: the list's end scrolls up from under it and fades out,
    /// so no row reads through the two rows. On the iPadOS 26 sidebar's glass that is the
    /// system's own scroll edge; elsewhere a fade into the page colour.
    @ViewBuilder func inboxFootBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            modifier(GlassFootBar(bar: bar()))
        } else {
            pageFootBar(bar)
        }
    }
    fileprivate func pageFootBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            bar().background(alignment: .top) {
                VStack(spacing: AceTheme.Spacing.none) {
                    LinearGradient(colors: [AceTheme.Colours.background.opacity(0), AceTheme.Colours.background],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: AceTheme.Spacing.xl)
                    AceTheme.Colours.background
                }
                .padding(.top, -AceTheme.Spacing.xl)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

@available(iOS 26, *)
private struct GlassFootBar<Bar: View>: ViewModifier {
    let bar: Bar
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    func body(content: Content) -> some View {
        if onGlass {
            content
                .safeAreaBar(edge: .bottom, spacing: AceTheme.Spacing.none) { bar }
                .scrollEdgeEffectStyle(.hard, for: .bottom)
        } else {
            content.pageFootBar { bar }
        }
    }
}
