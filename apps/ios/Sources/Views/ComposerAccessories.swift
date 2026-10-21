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
    private var name: String { screen.controls?.model.isEmpty == false ? screen.controls?.model ?? "Model" : "Choose model" }
    private var effort: String? { screen.tune.flatMap { tune in tune.efforts.first { $0.id == tune.effort }?.label } }
    var body: some View {
        Button(action: open) {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(name).lineLimit(1).truncationMode(.middle)
                if screen.tune?.speed != nil && screen.tune?.speed != "standard" { Image(systemName: "bolt.fill") }
                if let effort { Text(effort).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1) }
                Image(systemName: screen.controls?.switching == "queued" ? "clock" : "chevron.down")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel("Model and reasoning")
        .accessibilityValue([name, effort].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("composer.model")
    }
}
