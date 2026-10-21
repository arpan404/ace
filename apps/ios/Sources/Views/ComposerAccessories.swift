import SwiftUI

/// Above the composer: the files on the next message with their upload progress and the bridge's
/// notice. Effort and speed live in the model sheet. Every check (size, what the agent can read,
/// which levels exist) is the bridge's; this view draws what the bridge says.
struct ComposerAccessories: View {
    @Bindable var model: ClientModel
    let screen: ThreadScreenModel
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if !screen.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(screen.attachments) { file in AttachmentChip(file: file) { model.detach(file.id) } }
                    }
                }
            }
            // The bridge's notice and a failed pick sit below the controls, so a long
            // reason truncates instead of squeezing the + and tune chips.
            if let notice = screen.tune?.notice, !notice.isEmpty {
                Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(2)
            }

        }
        .padding(.horizontal, AceTheme.Dimensions.composerInset + AceTheme.Spacing.xs)
    }
}

/// A single model and reasoning control, with room for the chosen model's actual name.
struct ComposerModelButton: View {
    let screen: ThreadScreenModel
    let open: () -> Void
    /// The model's name; until the agent reports one, the provider's name stands in.
    private var name: String {
        guard let controls = screen.controls else { return "Choose model" }
        if !controls.model.isEmpty { return controls.model }
        if let provider = controls.providerName, !provider.isEmpty { return provider }
        return "Choose model"
    }
    private var effort: String? { screen.tune.flatMap { tune in tune.efforts.first { $0.id == tune.effort }?.label } }
    var body: some View {
        Button(action: open) {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                if let provider = screen.controls?.provider, !provider.isEmpty { ProviderMark(provider: provider) }
                Text(name).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: AceTheme.Dimensions.touchTarget * 3, alignment: .leading)
                Image(systemName: screen.controls?.switching == "queued" ? "clock" : "chevron.down")
                    .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .fixedSize(horizontal: true, vertical: false)
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.xs)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel("Model and reasoning")
        .accessibilityValue([name, effort].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("composer.model")
    }
}
