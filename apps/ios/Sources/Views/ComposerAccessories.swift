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

/// The thread composer's model control: the model (opens the model sheet) and its effort and
/// speed in brief (opens their panel), "◎ Opus 5.5 · Med ⌄".
struct ComposerModelButton: View {
    let screen: ThreadScreenModel
    let open: () -> Void
    let openTune: () -> Void
    private var name: String { Self.name(screen) }
    private var tune: String? { Self.tune(screen) }
    /// The model's name; until the agent reports one, the provider's name stands in.
    static func name(_ screen: ThreadScreenModel) -> String {
        guard let controls = screen.controls else { return "Choose model" }
        if !controls.model.isEmpty { return controls.model }
        if let provider = controls.providerName, !provider.isEmpty { return provider }
        return "Choose model"
    }
    /// "Med", "Med · Fast"; nil when the model has nothing to tune.
    static func tune(_ screen: ThreadScreenModel) -> String? {
        guard let tune = screen.tune else { return nil }
        let effort = tune.efforts.first { $0.id == tune.effort }
        let speed = tune.speeds.first { $0.speed == tune.speed && $0.speed != "standard" }
        return TuneSummary.text(effort: effort.map { $0.short ?? $0.label }, speed: speed?.label,
                                hasLevels: !tune.efforts.isEmpty, hasSpeeds: tune.speeds.count > 1)
    }
    var body: some View {
        ModelEffortChip(provider: screen.controls?.provider, model: name, effort: tune,
                        queued: screen.controls?.switching == "queued",
                        modelID: "composer.model", effortID: "composer.effort", openModel: open, openEffort: openTune)
    }
}

/// The thread composer's access control, when the thread reports access it can change.
struct ThreadAccessChip: View {
    let access: ThreadAccessRow?
    let set: (String) -> Void
    var body: some View {
        if let access, access.state != "none", access.state != "failed" || !access.choices.isEmpty {
            AccessChip(label: access.label ?? "Access", selected: access.selected,
                       items: access.choices.map { AccessItem(mode: $0.mode, label: $0.label, description: $0.description, attention: $0.attention) },
                       note: access.pending == true ? "Applies at the agent's next turn" : access.stricter,
                       loading: access.state == "loading" && access.choices.isEmpty,
                       identifier: "composer.access", select: set)
        }
    }
}

/// The composer's settings, from its settings button while it is one line: the model and its
/// effort (each opens its own sheet) and the access modes as rows to choose from.
struct ComposerSettingsSheet: View {
    let screen: ThreadScreenModel
    let openModel: () -> Void
    let openTune: () -> Void
    let setAccess: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    private var name: String { ComposerModelButton.name(screen) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: openModel) {
                        InsetRow(systemImage: nil, title: name, subtitle: screen.controls?.providerName.flatMap { $0 == name ? nil : $0 }) {
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                        }
                    }
                    .buttonStyle(.plain).insetRowBackground()
                    .accessibilityIdentifier("composer.settings.model")
                    if let tune = ComposerModelButton.tune(screen) {
                        Button(action: openTune) {
                            InsetRow(systemImage: nil, title: "Effort") {
                                HStack(spacing: AceTheme.Spacing.xs) {
                                    InsetValue(text: tune)
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                                }
                            }
                        }
                        .buttonStyle(.plain).insetRowBackground()
                        .accessibilityIdentifier("composer.settings.effort")
                    }
                } header: { InsetHeader("Model") }
                if let access = screen.access, !access.choices.isEmpty {
                    Section {
                        AccessRows(selected: access.selected,
                                   items: access.choices.map { AccessItem(mode: $0.mode, label: $0.label, description: $0.description, attention: $0.attention) },
                                   identifier: "composer.access") { mode in
                            if mode != access.selected { setAccess(mode) }
                            dismiss()
                        }
                    } header: { InsetHeader("Access") } footer: {
                        if let note = access.pending == true ? "Applies at the agent's next turn" : access.stricter { Text(note) }
                    }
                }
            }
            .insetGroupedList()
            .navigationTitle("This thread")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
