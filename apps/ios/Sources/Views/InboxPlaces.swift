import SwiftUI

/// Threads and Pull requests at the foot of the sidebar, where a regular window (iPad, the
/// unfolded iPhone Duo, a large iPhone turned) keeps them instead of the tab bar: one two-way
/// switch, the place showing filled. A compact window has the tab bar back while its list fills
/// the window; as the drawer over a thread the list keeps New thread here too, beside the switch
/// where the tab bar keeps it, since the list's bar has no room for it.
struct InboxPlaces: View {
    @Binding var tab: InboxTab
    var compose: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            GlassSwitch(selection: $tab, choices: [
                .init(value: .threads, title: "Threads", identifier: "sidebar.threads"),
                .init(value: .pulls, title: "Pull requests", identifier: "sidebar.pulls", short: "Pulls"),
            ])
            if let compose {
                Button(action: compose) {
                    AceIcon(.notePencil, size: 20)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .frame(width: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xs, height: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xs)
                        .contentShape(AceShape.capsule)
                }
                .buttonStyle(.plain)
                .aceGlass(in: AceShape.capsule, interactive: true)
                .accessibilityLabel("New thread")
                .accessibilityIdentifier("inbox.compose")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm)
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
