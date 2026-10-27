import SwiftUI

/// Threads and Pull requests at the foot of the sidebar, where a regular window (iPad, the
/// unfolded iPhone Duo, a large iPhone turned) keeps them instead of the tab bar: one two-way
/// switch, the place showing filled. A compact window has the tab bar back while its list fills
/// the window; as the drawer over a thread the list keeps New thread here too, beside the switch
/// where the tab bar keeps it, since the list's bar has no room for it.
struct InboxPlaces: View {
    @Binding var tab: InboxTab
    var compose: (() -> Void)? = nil
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if sizeClass == .regular {
            HStack(spacing: AceTheme.Spacing.sm) {
                GlassSwitch(selection: $tab, choices: [
                    .init(value: .threads, title: "Threads", identifier: "sidebar.threads"),
                    .init(value: .pulls, title: "Pull requests", identifier: "sidebar.pulls", short: "Pulls"),
                ])
                if let compose { ComposeCircle(action: compose, size: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xs) }
            }
            .padding(.horizontal, AceTheme.Spacing.md)
            .padding(.vertical, AceTheme.Spacing.sm)
        } else {
            // A compact window's drawer and full list wear the same bar the window shows with
            // nothing open: Threads and Pulls with their icons, New thread on its own circle.
            HStack(spacing: AceTheme.Spacing.sm) {
                PlacesTabBar(tab: $tab)
                Spacer(minLength: AceTheme.Spacing.sm)
                if let compose { ComposeCircle(action: compose, size: PlacesTabBar.height) }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .padding(.bottom, AceTheme.Spacing.xs)
        }
    }
}

/// Threads and Pulls as the tab bar draws them: an icon over its word, the place showing on a
/// filled capsule that slides between them, all on one glass capsule.
private struct PlacesTabBar: View {
    @Binding var tab: InboxTab
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Namespace private var fill
    static let height: CGFloat = 62

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            item(.threads, title: "Threads", icon: Image(systemName: "text.bubble"), identifier: "sidebar.threads")
            item(.pulls, title: "Pulls", icon: Image("tab-pulls"), identifier: "sidebar.pulls")
        }
        .padding(4)
        .frame(height: Self.height)
        .aceGlass(in: AceShape.capsule, interactive: true)
    }

    private func item(_ value: InboxTab, title: String, icon: Image, identifier: String) -> some View {
        let chosen = tab == value
        return Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) { tab = value }
        } label: {
            VStack(spacing: 2) {
                icon.font(.system(size: 20, weight: .medium)).frame(height: 24)
                Text(title).font(.system(size: 11, weight: .semibold)).lineLimit(1)
            }
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .frame(width: 88)
            .frame(maxHeight: .infinity)
            .background {
                if chosen {
                    AceShape.capsule.fill(AceTheme.Colours.foreground.opacity(0.12))
                        .matchedGeometryEffect(id: "chosen", in: fill)
                }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: chosen)
        .accessibilityLabel(title)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// New thread on its own glass circle, beside the places.
private struct ComposeCircle: View {
    let action: () -> Void
    let size: CGFloat
    var body: some View {
        Button(action: action) {
            AceIcon(.notePencil, size: 22)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Circle(), interactive: true)
        .accessibilityLabel("New thread")
        .accessibilityIdentifier("inbox.compose")
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
