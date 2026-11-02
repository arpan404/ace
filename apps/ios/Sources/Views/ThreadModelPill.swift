import SwiftUI

/// The row just above the composer, under any request strip: the thread's model on the left and,
/// to its right, the live pill while something runs. Left-aligned on the composer's edge; the
/// model never takes more than about 60% of the row, so the two always share it.
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
            HStack(spacing: AceTheme.Spacing.sm) {
                if let model {
                    ThreadModelPill(screen: model, openModel: openModel, openTune: openTune, openSettings: openSettings)
                        .frame(maxWidth: width > 0 ? width * 0.6 : nil, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let pill {
                    LivePillCapsule(pill: pill, open: open)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94)))
                }
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .padding(.horizontal, ReadingColumn.bar(sizeClass).composer)
            .padding(.bottom, AceTheme.Spacing.sm)
            .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: pill)
        }
    }
}

/// The thread's model as a compact capsule: the provider's mark in its colours, the model's
/// name (cut in the middle when long, so its version still reads) and its effort ("· Med"),
/// which always shows, then a caret. A tap opens the model picker; a long press offers the
/// model and access sheet. A switch not in effect yet shows a clock in place of the caret.
struct ThreadModelPill: View {
    let screen: ThreadScreenModel
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
                Text(name).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(AceTheme.Colours.foreground)
                if let tune {
                    Text("· \(tune)").lineLimit(1).fixedSize()
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
