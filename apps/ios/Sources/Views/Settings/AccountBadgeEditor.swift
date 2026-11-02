import SwiftUI

/// The badge preview and what a save sends, from the bridge (`accounts.screen.badge`).
private struct BadgeAnswer: ManageAnswer {
    struct Preview: Decodable {
        struct Save: Decodable { let shortLabel: String?; let badgeUsesInitial: Bool; let badgeColor: String; let badgeIcon: String? }
        let text: String
        let icon: String?
        let color: String
        let problem: String?
        let save: Save
        var look: AccountBadgeLook { AccountBadgeLook(text: text, icon: icon, color: color) }
    }
    let ok: Bool
    let problem: String?
    let badge: Preview?
}

/// The badge choices a form edits: letters, or an icon, on a colour.
struct BadgeDraft: Equatable {
    var letters = ""
    var icon: String?
    var colour = "neutral"
    var payload: [String: Any] {
        var value: [String: Any] = ["shortLabel": letters, "color": colour]
        if let icon { value["icon"] = icon }
        return value
    }
}

/// Letters, icon and colour for an account badge, with the badge drawn live above them.
struct BadgeFields: View {
    let model: ClientModel
    let name: String
    @Binding var draft: BadgeDraft
    /// The bridge's word on the typed letters; nil when they can be saved.
    @Binding var problem: String?
    @State private var look = AccountBadgeLook(text: "?", icon: nil, color: "neutral")
    @Environment(\.aceReduceMotion) private var reduceMotion
    var body: some View {
        Section {
            HStack(spacing: AceDesign.Space.row) {
                AccountBadgeMark(look: look, size: AceDesign.Size.tap)
                    .animation(AceDesign.Motion.arriving(reduceMotion), value: look)
                TextField("Letters", text: $draft.letters)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .accessibilityLabel("Badge letters")
                    .onChange(of: draft.letters) { if !draft.letters.isEmpty { draft.icon = nil } }
            }
            .padding(.vertical, AceDesign.Space.tight)
            if let problem {
                Text(problem).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .transition(.opacity)
            }
        } header: { InsetHeader("Badge") } footer: { Text("Up to two letters, or an icon. Leave it blank to use the name's first letter.") }
        Section {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: AceDesign.Space.tight), count: 6), spacing: AceDesign.Space.tight) {
                choice(selected: draft.icon == nil, label: "Use letters") {
                    Text("Aa").font(AceDesign.Typeface.body.weight(AceDesign.Typeface.strong)).fontDesign(.rounded)
                } action: { draft.icon = nil }
                ForEach(AccountBadgeStyle.icons, id: \.id) { icon in
                    choice(selected: draft.icon == icon.id, label: "Use \(icon.label.lowercased()) badge") {
                        Image(systemName: icon.symbol).font(AceDesign.Typeface.body.weight(AceDesign.Typeface.strong))
                    } action: { draft.icon = icon.id; draft.letters = "" }
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
        } header: { InsetHeader("Icon") }
        Section {
            HStack(spacing: AceDesign.Space.related) {
                ForEach(AccountBadgeStyle.colours, id: \.self) { colour in
                    Button { draft.colour = colour } label: {
                        Circle().fill(AccountBadgeStyle.fill(colour)).frame(width: AceDesign.Size.swatch, height: AceDesign.Size.swatch)
                            .padding(AceDesign.Space.tight)
                            .overlay { Circle().strokeBorder(AceDesign.Ink.accent, lineWidth: AceDesign.Size.ring).opacity(draft.colour == colour ? 1 : 0) }
                            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(AccountBadgeStyle.name(colour))
                    .accessibilityAddTraits(draft.colour == colour ? .isSelected : [])
                }
            }
            .smoothChange(draft.colour)
        } header: { InsetHeader("Colour") }
        .sensoryFeedback(.selection, trigger: draft)
        .task(id: PreviewKey(name: name, draft: draft)) { await preview() }
    }
    private struct PreviewKey: Equatable { let name: String; let draft: BadgeDraft }
    private func choice<Glyph: View>(selected: Bool, label: String, @ViewBuilder glyph: () -> Glyph, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            glyph()
                .foregroundStyle(selected ? AceDesign.Ink.onAccent : AceDesign.Ink.primary)
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                .background(AceDesign.Shape.control.fill(selected ? AceDesign.Ink.accent : Color.clear))
                .contentShape(AceDesign.Shape.control)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .smoothChange(selected)
    }
    private func preview() async {
        var payload = draft.payload
        payload["type"] = "accounts.screen.badge"; payload["label"] = name
        guard let answer = try? await model.manage(payload, as: BadgeAnswer.self), let badge = answer.badge else { return }
        withAnimation(AceDesign.Motion.arriving(reduceMotion)) { look = badge.look; problem = badge.problem }
    }
}

/// Edit an account's name and badge, seeing the badge change as it's edited.
struct AccountBadgeEditor: View {
    let model: ClientModel
    let provider: String
    let account: AccountRowData
    let saved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var draft: BadgeDraft
    @State private var badgeProblem: String?
    @State private var problem: String?
    @State private var saving = false
    @State private var done = false
    init(model: ClientModel, provider: String, account: AccountRowData, saved: @escaping () -> Void) {
        self.model = model; self.provider = provider; self.account = account; self.saved = saved
        _name = State(initialValue: account.label)
        _draft = State(initialValue: BadgeDraft(letters: account.typedBadge, icon: account.badge.icon, colour: account.badge.color))
    }
    var body: some View {
        Form {
            Group {
                Section { TextField("Name", text: $name).accessibilityLabel("Account name") } header: { InsetHeader("Name") }
                BadgeFields(model: model, name: name, draft: $draft, problem: $badgeProblem)
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Edit \(account.label)").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving || badgeProblem != nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canOperate)
            }
        }
        .sensoryFeedback(.success, trigger: done)
        .interactiveDismissDisabled(saving)
    }
    private func save() async {
        saving = true; problem = nil
        defer { saving = false }
        var payload = draft.payload
        payload["type"] = "accounts.screen.rename"; payload["provider"] = provider
        payload["instanceId"] = account.id; payload["label"] = name
        do {
            _ = try await model.manage(payload, as: PlainAnswer.self)
            done = true; saved(); dismiss()
        } catch { problem = error.localizedDescription }
    }
}
