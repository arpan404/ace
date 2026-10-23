import SwiftUI

/// Inside the composer, above the message: the files on the next message with their upload
/// progress, the bridge's notice and a pick that couldn't be read. Effort and speed live in the
/// model sheet. Every check (size, what the agent can read, which levels exist) is the bridge's;
/// this view draws what the bridge says.
struct ComposerAccessories: View {
    @Bindable var model: ClientModel
    let screen: ThreadScreenModel
    let problem: String?
    private var notice: String? { screen.tune?.notice.isEmpty == false ? screen.tune?.notice : nil }
    var body: some View {
        if !screen.attachments.isEmpty || notice != nil || problem != nil {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                if !screen.attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: AceTheme.Spacing.xs) {
                            ForEach(screen.attachments) { file in AttachmentChip(file: file) { model.detach(file.id) } }
                        }
                    }
                }
                if let notice {
                    Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(2)
                }
                ServiceProblem(message: problem)
            }
            .padding(.horizontal, AceTheme.Spacing.sm).padding(.top, AceTheme.Spacing.sm)
        }
    }
}

/// The composer's one model control: the provider's mark, the model, a dot and the effort in
/// brief ("Opus 5.5 · Med"), and a caret. It opens the model and effort picker.
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
    private var effort: TuneRow.Effort? { screen.tune.flatMap { tune in tune.efforts.first { $0.id == tune.effort } } }
    var body: some View {
        Button(action: open) {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                if let provider = screen.controls?.provider, !provider.isEmpty { ProviderMark(provider: provider) }
                Text(name).foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(1).truncationMode(.tail)
                    // Narrow enough that "Ask anything" beside it never truncates on a 6.1" phone.
                    .frame(maxWidth: AceTheme.Spacing.xxxl * 2 + AceTheme.Spacing.lg, alignment: .leading)
                if let effort {
                    Text("·").foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
                    Text(effort.short ?? effort.label).lineLimit(1)
                }
                AceIcon(screen.controls?.switching == "queued" ? .clock : .caretDown, size: 12, relativeTo: .caption)
                    .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .fixedSize(horizontal: true, vertical: false)
            .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel("Model and reasoning")
        .accessibilityValue([name, effort?.label].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("composer.model")
    }
}
