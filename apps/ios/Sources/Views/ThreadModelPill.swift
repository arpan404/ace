import SwiftUI

/// The thread's model on top, centred under its title: one capsule with the provider's mark in
/// its colours, the model's name and its effort ("Opus 5.5 · Med") and a caret. A tap opens the
/// model picker; the effort opens Effort and speed. Its context menu reaches Access too, which
/// left the composer with it. A switch not in effect yet shows a clock in place of the caret.
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
        HStack(spacing: AceTheme.Spacing.none) {
            Button(action: openModel) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    if let provider = screen.controls?.provider, !provider.isEmpty {
                        ProviderMark(provider: provider, size: 14)
                    }
                    Text(name).lineLimit(1).truncationMode(.tail)
                        .foregroundStyle(AceTheme.Colours.foreground)
                }
                .padding(.leading, AceTheme.Spacing.md)
                .padding(.trailing, tune == nil ? AceTheme.Spacing.xs : AceTheme.Spacing.xxs)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Model").accessibilityValue(name).accessibilityHint(note ?? "")
            .accessibilityIdentifier("thread.model")
            if let tune {
                Button(action: openTune) {
                    Text("· \(tune)").lineLimit(1)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .padding(.trailing, AceTheme.Spacing.xs)
                        .frame(minHeight: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Effort and speed").accessibilityValue(tune)
                .accessibilityIdentifier("thread.effort")
            }
            Button(action: openModel) {
                AceIcon(queued ? .clock : .caretDown, size: 11, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .padding(.trailing, AceTheme.Spacing.md)
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
        .fontWeight(.medium)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .contextMenu {
            Button("Choose model", ace: .sparkle, action: openModel)
            if tune != nil { Button("Effort and speed", ace: .slidersHorizontal, action: openTune) }
            Button("Model and access", ace: .shield, action: openSettings)
        }
    }
}

/// Hangs the model pill centred under the navigation bar, on the bar's own band (iOS 26's
/// `safeAreaBar`, so the transcript's edge effect runs under it), or as a plain inset before.
struct ModelPillBar<Pill: View>: ViewModifier {
    let shown: Bool
    @ViewBuilder let pill: () -> Pill
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.safeAreaBar(edge: .top, spacing: AceTheme.Spacing.none) { band }
        } else {
            content.safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { band }
        }
    }
    @ViewBuilder private var band: some View {
        if shown {
            pill()
                .frame(maxWidth: .infinity)
                .padding(.top, AceTheme.Spacing.xxs)
                .padding(.bottom, AceTheme.Spacing.xs)
        }
    }
}
