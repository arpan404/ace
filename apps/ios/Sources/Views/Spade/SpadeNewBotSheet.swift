import SwiftUI

/// New bot (ADR 0197, docs/design/spade.md §5): one question, "What should this bot do?", and
/// the person's answer is its task and its first message. It names itself and picks its face as
/// it starts. A template brings its own name, face and task, and the message becomes its first
/// job, and its routines show with their schedules, to start now or keep paused (ADR 0132). The
/// model is optional; untouched, it is Settings' model for new bots. Made, the sheet closes on
/// the bot's conversation. A bot made whose first message didn't go is never made again: the
/// message is sent to it (`SpadeNewBotProgress`).
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
    @State private var progress = SpadeNewBotProgress()
    /// A template's routines start on their schedules unless the person keeps them paused.
    @State private var startRoutines = true
    @FocusState private var focused: Bool

    private var typed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var problem: String? { progress.problem }
    /// The bot is made already: only its first message is left to send.
    private var madeAlready: String? {
        if case .send(let conversation) = progress.next { conversation } else { nil }
    }
    private var canMake: Bool {
        !making && (madeAlready == nil ? !typed.isEmpty || template != nil : !typed.isEmpty)
    }

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
                if let routines = template?.routines {
                    Section {
                        Toggle(isOn: $startRoutines) {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                Text("Start its routines").aceFont(AceDesign.TextRole.rowTitle)
                                Text(routines).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                            }
                        }
                        .disabled(making || madeAlready != nil)
                        .accessibilityIdentifier("spade.newbot.routines")
                    } footer: {
                        if !startRoutines { Text("They wait, paused, until you start them from its profile on the computer.") }
                    }
                }
                if madeAlready == nil, let templates = offer?.templates, !templates.isEmpty {
                    Section {
                        ForEach(templates) { templateRow($0) }
                    } header: {
                        InsetHeader("Or start from a template")
                    }
                }
                if madeAlready == nil, let setting = offer?.model, let groups = offer?.groups, !groups.isEmpty {
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
                    if let conversation = madeAlready {
                        // Made already: leaving opens it, the message still in this field's words.
                        Button("Open") { open(conversation) }.disabled(making).accessibilityIdentifier("spade.newbot.open")
                    } else {
                        Button("Cancel") { dismiss() }.disabled(making).accessibilityIdentifier("spade.newbot.cancel")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if making { ProgressView() } else {
                        Button(madeAlready == nil ? "Create" : "Send again", action: create)
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
            startRoutines = true
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
                if picked { AceIcon(.check).foregroundStyle(AceDesign.Ink.action).accessibilityHidden(true) }
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
        focused = false
        Task {
            let opening: String?
            switch progress.next {
            case .create:
                let answer = await client.spadeNewBotCreate(text: typed, template: template?.id,
                                                            model: model.isEmpty ? nil : model, startRoutines: startRoutines)
                opening = progress.land(answer)
            case .send(let conversation):
                opening = progress.sent(await client.spadeSend(conversation, text: typed), to: conversation)
            }
            making = false
            if let opening { open(opening) }
        }
    }

    private func open(_ conversation: String) {
        dismiss()
        made(conversation)
    }
}
