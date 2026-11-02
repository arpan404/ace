import SwiftUI

/// The row just above the composer, under any request strip: the thread's model on the left and,
/// to its right, the live pill while something runs. Left-aligned on the composer's edge; the
/// model takes at most 60% of the row on its own, 40% beside the live pill, so the two share it.
struct ComposerPills: View {
    /// The thread's controls, or nil where the model can't be changed (view only, archived).
    let model: ThreadScreenModel?
    let pill: PillRow?
    let open: (String) -> Void
    let openModel: () -> Void
    let openTune: () -> Void
    let openSettings: () -> Void
    @State private var width: CGFloat = 0
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.aceReduceMotion) private var reduceMotion

    var body: some View {
        if model != nil || pill != nil {
            // Both whole when they fit. When they don't, the model keeps at most 40% of the row
            // (its long name cut in the middle) and the live pill takes the rest.
            ViewThatFits(in: .horizontal) {
                row(capped: false)
                // Tight beside the live pill: the provider's mark and the effort, no name.
                if pill != nil { row(capped: false, named: false) }
                row(capped: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            // On the glass block's top edge: inset to its inner edge, close above it.
            .padding(.horizontal, ReadingColumn.bar(sizeClass).composer + GlassBlock.inset)
            .padding(.bottom, AceTheme.Spacing.xs)
            .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: pill)
        }
    }

    private func row(capped: Bool, named: Bool = true) -> some View {
        let cap = capped && width > 0 ? width * (pill == nil ? 0.6 : 0.4) : CGFloat.infinity
        return HStack(spacing: AceTheme.Spacing.sm) {
            if let model {
                CappedWidth(max: cap) {
                    ThreadModelPill(screen: model, named: named, openModel: openModel, openTune: openTune, openSettings: openSettings)
                }
                .fixedSize(horizontal: !capped, vertical: false)
            }
            if let pill {
                LivePillCapsule(pill: pill, open: open)
                    .fixedSize(horizontal: !capped, vertical: false)
                    .layoutPriority(1)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)))
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
    }
}

/// The thread's model as a compact capsule: the provider's mark in its colours, the model's
/// name (cut in the middle when long, so its version still reads) and its effort ("· Med"),
/// which always shows, then a caret. A tap opens the model picker; a long press offers the
/// model and access sheet. A switch not in effect yet shows a clock in place of the caret.
struct ThreadModelPill: View {
    let screen: ThreadScreenModel
    /// False where the row is tight: the provider's mark stands for the model.
    var named = true
    let openModel: () -> Void
    let openTune: () -> Void
    let openSettings: () -> Void

    var body: some View {
        let name = ComposerModelButton.name(screen)
        let tune = ComposerModelButton.tune(screen)
        let note = screen.controls?.note.flatMap { $0.isEmpty ? nil : $0 }
        let queued = screen.controls?.switching == "queued" || note != nil
        Button(action: openModel) {
            HStack(spacing: AceTheme.Spacing.xs) {
                if let provider = screen.controls?.provider, !provider.isEmpty {
                    ProviderMark(provider: provider, size: 14)
                }
                if named {
                    Text(name).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(AceTheme.Colours.foreground)
                }
                if let tune {
                    Text(named ? "· \(tune)" : tune).lineLimit(1).fixedSize()
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .layoutPriority(1)
                }
                AceIcon(queued ? .clock : .caretDown, size: 11, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .layoutPriority(1)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: LivePillCapsule.height)
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .accessibilityLabel("Model")
        .accessibilityValue(tune.map { "\(name), \($0)" } ?? name)
        .accessibilityHint(note ?? "")
        .accessibilityIdentifier("thread.model")
        .contextMenu {
            Button("Choose model", ace: .sparkle, action: openModel)
            if tune != nil { Button("Effort and speed", ace: .slidersHorizontal, action: openTune) }
            Button("Model and access", ace: .shield, action: openSettings)
        }
    }
}

/// Proposes at most `max` to its one view and takes the size it chooses: a flexible frame would
/// grow to the cap, while this lets the pill hug its words and still cut a long name.
struct CappedWidth: Layout {
    let max: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        return view.sizeThatFits(ProposedViewSize(width: Swift.min(proposal.width ?? max, max), height: proposal.height))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
