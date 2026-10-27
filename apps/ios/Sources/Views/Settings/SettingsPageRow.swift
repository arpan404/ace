import SwiftUI

/// One row of a machine settings page, drawn from its control: a switch, a menu or segmented
/// choice, a text or number field, a list of names, a model that opens the model sheet, or a
/// link to another page. Under the title, one quiet line says where the value comes from and,
/// with All machines, which machines hold another value. A change shows at once while it saves.
struct SettingsPageRowView: View {
    let model: ClientModel
    let row: SettingsPageData.Row
    /// The change being saved, drawn in place of the value until the machine answers.
    let pending: SettingsPageInput?
    /// "Mac mini: Steer" for each machine holding another value.
    let others: [String]
    let problem: String?
    let enabled: Bool
    let change: (SettingsPageInput) -> Void
    let pick: () -> Void

    @State private var words = ""
    @State private var entries: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            control
            if let note = row.note { caption(note).contentTransition(.opacity).accessibilityIdentifier("setting.\(row.id).note") }
            if let locked = row.locked { caption(locked) }
            ServiceProblem(message: problem)
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .disabled(!enabled || pending != nil && !isInstant)
        .onAppear(perform: reset)
        .onChange(of: row.value) { reset() }
    }

    /// Switches and choices show the change at once; fields wait for the answer.
    private var isInstant: Bool {
        switch row.control { case .toggle, .choice: true; default: false }
    }
    private var subtitle: String? {
        let parts = [row.source?.label].compactMap { $0 } + others
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var control: some View {
        switch row.control {
        case .toggle:
            Toggle(isOn: Binding(get: { if case .bool(let on)? = pending { on } else { row.value.bool } }, set: { change(.bool($0)) })) { label }
                .accessibilityIdentifier("setting.\(row.id)")
        case .choice(let segmented, let choices):
            if let empty = row.empty {
                HStack { label; Spacer(); caption(empty) }
            } else if segmented {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    label
                    picker(choices).pickerStyle(.segmented)
                }
            } else {
                menu(choices)
            }
        case .text(let placeholder):
            field(placeholder, keyboard: .default)
        case .number:
            field(row.title, keyboard: .numberPad)
        case .list(let placeholder, let add):
            list(placeholder: placeholder, add: add)
        case .model(_, let provider, let label, let account, let clear, let cleared):
            Button(action: pick) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    self.label
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if let provider { ProviderMark(provider: provider, size: 16) }
                    InsetValue(text: [label, account].compactMap { $0 }.joined(separator: " · "))
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("setting.\(row.id)")
            if !cleared {
                Button(clear == "Auto" ? "Use Auto" : "Clear") { change(.pick(nil)) }
                    .buttonStyle(.borderless).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("setting.\(row.id).clear")
            }
        case .link(let page, let provider, let label):
            NavigationLink {
                SettingsPageView(model: model, page: page, title: row.title)
            } label: {
                HStack(spacing: AceTheme.Spacing.sm) {
                    self.label
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if let provider { ProviderMark(provider: provider, size: 16) }
                    InsetValue(text: label).contentTransition(.opacity)
                }
            }
            .accessibilityIdentifier("setting.\(row.id)")
        }
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(row.title).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                Text(subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .contentTransition(.opacity)
                    .accessibilityIdentifier("setting.\(row.id).source")
            }
        }
    }
    private func caption(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func picker(_ choices: [SettingsPageData.Choice]) -> some View {
        let selected = if case .choice(let id)? = pending { id } else { row.value.text }
        return Picker(selection: Binding(get: { selected }, set: { change(.choice($0)) })) {
            ForEach(choices) { Text($0.label).tag($0.id) }
        } label: { label }
        .accessibilityIdentifier("setting.\(row.id)")
    }
    /// Title on the left, the chosen value on the right; the menu lists every choice.
    private func menu(_ choices: [SettingsPageData.Choice]) -> some View {
        let selected = if case .choice(let id)? = pending { id } else { row.value.text }
        let shown = choices.first { $0.id == selected }?.label ?? selected
        return HStack(spacing: AceTheme.Spacing.sm) {
            label
            Spacer(minLength: AceTheme.Spacing.sm)
            Menu {
                Picker(row.title, selection: Binding(get: { selected }, set: { change(.choice($0)) })) {
                    ForEach(choices) { Text($0.label).tag($0.id) }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: AceTheme.Spacing.xxs) {
                    Text(shown).multilineTextAlignment(.trailing).lineLimit(2).contentTransition(.opacity)
                    Image(systemName: "chevron.up.chevron.down").font(.footnote.weight(.medium))
                }
                .aceFont(InsetStyle.value, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
            }
            .accessibilityIdentifier("setting.\(row.id)")
            .accessibilityLabel(row.title)
            .accessibilityValue(shown)
        }
    }

    private func field(_ placeholder: String, keyboard: UIKeyboardType) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            label
            HStack {
                TextField(placeholder, text: $words, axis: .vertical)
                    .keyboardType(keyboard)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(save)
                    .accessibilityIdentifier("setting.\(row.id)")
                if words != row.value.text {
                    if pending != nil { ProgressView() } else { Button("Save", action: save).buttonStyle(.borderless) }
                }
            }
        }
    }
    private func save() {
        if case .number = row.control {
            guard let number = Double(words.trimmingCharacters(in: .whitespaces)), number.isFinite else { return }
            change(.number(number))
        } else { change(.text(words)) }
    }

    private func list(placeholder: String, add: String) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            label
            ForEach(entries.indices, id: \.self) { index in
                HStack {
                    TextField(placeholder, text: Binding(get: { entries.indices.contains(index) ? entries[index] : "" },
                                                         set: { if entries.indices.contains(index) { entries[index] = $0 } }))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button { entries.remove(at: index) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless).accessibilityLabel("Remove")
                        .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                }
                .transition(.opacity)
            }
            HStack {
                Button(add) { withAnimation(.smooth) { entries.append("") } }.disabled(entries.count >= 200)
                Spacer()
                if entries != row.value.list { Button("Save") { change(.list(entries)) } }
            }
            .buttonStyle(.borderless)
        }
        .accessibilityIdentifier("setting.\(row.id)")
    }

    private func reset() {
        words = row.value.text
        entries = row.value.list
    }
}
