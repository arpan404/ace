import SwiftUI

/// Threads and Pull requests at the foot of the sidebar, where a regular window (iPad, the
/// unfolded iPhone Duo, a large iPhone turned) keeps them instead of the tab bar: two quiet rows,
/// the one showing filled as a selected row is. A compact window has the tab bar back.
struct InboxPlaces: View {
    @Binding var tab: InboxTab

    var body: some View {
        VStack(spacing: AceTheme.Spacing.xxs) {
            place("Threads", systemImage: "text.bubble", tab: .threads, id: "sidebar.threads")
            place("Pull requests", image: "tab-pulls", tab: .pulls, id: "sidebar.pulls")
        }
        .padding(.horizontal, AceTheme.Spacing.sm)
        .padding(.vertical, AceTheme.Spacing.sm)
    }

    private func place(_ title: String, systemImage: String? = nil, image: String? = nil, tab place: InboxTab, id: String) -> some View {
        Button { tab = place } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                Group {
                    if let systemImage { Image(systemName: systemImage) } else if let image { Image(image) }
                }
                .frame(width: AceTheme.Dimensions.touchTarget / 2)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                Text(title).aceFont(AceTheme.Typography.label, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
        }
        .buttonStyle(RowPressStyle(selected: tab == place))
        .accessibilityAddTraits(tab == place ? .isSelected : [])
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
