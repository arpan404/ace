import SwiftUI

/// One choice in a `GlassChoice`: words, and a provider mark or symbol before them.
struct GlassChoiceItem: Identifiable, Equatable {
    enum Glyph: Equatable { case provider(String, quiet: Bool), symbol(String) }
    let id: String
    let label: String
    var glyph: Glyph? = nil
}

/// Exclusive choices in words on one glass capsule (system glass on iOS 26, the regular material
/// on iOS 18): the chosen one sits on a flat thumb that springs across as the choice moves, as
/// DESIGN.md's segmented control does. It scrolls sideways when the words don't fit. The model
/// sheet's tabs and its Effort, Speed and Access use it.
struct GlassChoice: View {
    let items: [GlassChoiceItem]
    let selection: String?
    /// "<prefix>.<id>" for each choice.
    let idPrefix: String
    var disabled = false
    let select: (String) -> Void
    @Namespace private var thumb
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    ForEach(items) { item in segment(item).id(item.id) }
                }
                .padding(AceTheme.Spacing.xxs + 1)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .aceGlass(in: AceShape.capsule, interactive: !disabled)
            .clipShape(AceShape.capsule)
            .opacity(disabled ? AceTheme.Opacity.disabled(scheme) : 1)
            .onAppear { if let selection { scroller.scrollTo(selection, anchor: .center) } }
            .onChange(of: selection) { _, id in
                if let id { withAnimation(.easeOut(duration: 0.2)) { scroller.scrollTo(id, anchor: .center) } }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// A lifted page-coloured thumb in light, the quiet fill in dark.
    private var thumbFill: Color { scheme == .dark ? AceTheme.Colours.fill : AceTheme.Colours.glass }

    private func segment(_ item: GlassChoiceItem) -> some View {
        let on = item.id == selection
        return Button {
            guard !on, !disabled else { return }
            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) { select(item.id) }
        } label: {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                switch item.glyph {
                case .provider(let provider, let quiet)?: ProviderMark(provider: provider, size: 16, quiet: quiet)
                case .symbol(let name)?: Image(systemName: name).font(.system(size: 13, weight: .semibold))
                case nil: EmptyView()
                }
                Text(item.label).lineLimit(1)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .fontWeight(on ? .semibold : .medium)
            .foregroundStyle(on ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: 34)
            .background {
                if on { AceShape.capsule.fill(thumbFill).matchedGeometryEffect(id: "thumb", in: thumb) }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(item.label)
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("\(idPrefix).\(item.id)")
        .sensoryFeedback(.selection, trigger: on)
    }
}
