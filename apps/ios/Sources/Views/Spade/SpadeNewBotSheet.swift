import SwiftUI

/// New bot (ADR 0197, docs/design/spade.md §5): one question, "What should this bot do?", and
/// the person's answer is its task and its first message. It names itself and picks its face as
/// it starts. A template brings its own name, face and task, and the message becomes its first
/// job. The model is optional; untouched, it is Settings' model for new bots. Made, the sheet
/// closes on the bot's conversation.
struct SpadeNewBotSheet: View {
    let client: ClientModel
    /// The bot was made: its conversation opens.
    let made: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var offer: SpadeNewBotAnswer?
    @State private var text = ""
    @State private var template: SpadeNewBotAnswer.Template?
    @State private var model = ""
    @State private var making = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var typed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canMake: Bool { !making && (!typed.isEmpty || template != nil) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(template == nil ? "Describe the job in your words" : "Its first job, in your words",
                              text: $text, axis: .vertical)
                        .aceFont(AceDesign.TextRole.message)
                        .lineLimit(3...10)
                        .focused($focused)
                        .disabled(making)
                        .accessibilityIdentifier("spade.newbot.field")
                } header: {
                    question
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("spade.newbot.problem")
                    } else if template == nil {
                        Text("It picks its own name and face as it starts.")
                    }
                }
                if let templates = offer?.templates, !templates.isEmpty {
                    Section {
                        ForEach(templates) { templateRow($0) }
                    } header: {
                        InsetHeader("Or start from a template")
                    }
                }
                if let setting = offer?.model, let groups = offer?.groups, !groups.isEmpty {
                    Section {
                        NavigationLink {
                            SpadeModelChoices(setting: chosen(setting), groups: groups, more: 0) { model = $0 }
                        } label: {
                            SpadeSettingRow(title: "Model", value: words(setting, groups))
                        }
                        .disabled(making)
                        .accessibilityIdentifier("spade.newbot.model")
                    }
                }
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(making || !typed.isEmpty)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(making).accessibilityIdentifier("spade.newbot.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if making { ProgressView() } else {
                        Button("Create", action: create)
                            .fontWeight(AceDesign.Typeface.strong)
                            .disabled(!canMake)
                            .accessibilityIdentifier("spade.newbot.create")
                    }
                }
            }
        }
        .task { await load() }
        .onAppear { focused = true }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("spade.newbot.sheet")
    }

    /// The page's one question, or the template's, over the field.
    private var question: some View {
        HStack(spacing: AceDesign.Space.related) {
            if let template { SpadeFaceView(face: template.face) }
            Text(template.map { "What should \($0.name) do first?" } ?? "What should this bot do?")
                .aceFont(AceDesign.TextRole.header)
                .foregroundStyle(AceDesign.Ink.primary)
                .textCase(nil)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.bottom, AceDesign.Space.tight)
    }

    private func templateRow(_ each: SpadeNewBotAnswer.Template) -> some View {
        let picked = template?.id == each.id
        return Button {
            template = picked ? nil : each
        } label: {
            HStack(spacing: AceDesign.Space.row) {
                SpadeFaceView(face: each.face)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(each.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    if !each.blurb.isEmpty {
                        Text(each.blurb).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: AceDesign.Space.related)
                if picked { Image(systemName: "checkmark").foregroundStyle(AceDesign.Ink.action).accessibilityHidden(true) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(making)
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityIdentifier("spade.newbot.template.\(each.id)")
    }

    /// The setting as this sheet has it: the person's pick, or Settings' default.
    private func chosen(_ setting: SpadeSettings.ModelSetting) -> SpadeSettings.ModelSetting {
        SpadeSettings.ModelSetting(role: setting.role, title: setting.title, line: nil, value: model,
                                   words: setting.words, none: setting.none)
    }

    private func words(_ setting: SpadeSettings.ModelSetting, _ groups: [SpadeSettings.Group]) -> String {
        guard !model.isEmpty else { return setting.words }
        for group in groups {
            if let found = group.choices.first(where: { $0.value == model }) { return "\(found.name) · \(group.label)" }
        }
        return model
    }

    private func load() async {
        // Templates and models are extras: unread, a bot is still made from the message alone.
        let answer = await client.spadeNewBotRead()
        if answer.ok { offer = answer }
    }

    private func create() {
        guard canMake else { return }
        making = true
        problem = nil
        focused = false
        Task {
            let answer = await client.spadeNewBotCreate(text: typed, template: template?.id, model: model.isEmpty ? nil : model)
            making = false
            guard answer.ok, let conversation = answer.conversation else {
                problem = answer.problem
                return
            }
            dismiss()
            made(conversation)
        }
    }
}
