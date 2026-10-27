import SwiftUI

/// Settings › Keyboard: Send with Return, then every hardware-keyboard shortcut with its keys.
/// A rebindable one opens its editor; Esc belongs to the system and only shows. Rebindings are
/// kept on this phone (`PhoneKeymap`).
struct KeyboardSettingsView: View {
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    @AppStorage(PhoneKeymap.storageKey) private var stored = ""
    @State private var confirmReset = false

    var body: some View {
        let keymap = PhoneKeymap(stored: stored)
        List {
            Section {
                InsetRow(systemImage: "return", title: "Send with Return") {
                    Toggle("Send with Return", isOn: $returnSends).labelsHidden()
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("keyboard.returnSends")
            } header: { InsetHeader("Typing") }
            .insetRowBackground()
            ForEach(groups, id: \.self) { group in
                Section {
                    ForEach(PhoneKeymapTable.entries.filter { $0.group == group }, id: \.id) { entry in row(entry, keymap: keymap) }
                } header: { InsetHeader(group) } footer: {
                    if group == groups.last { Text("Shortcuts work with a hardware keyboard.") }
                }
                .insetRowBackground()
            }
            if !keymap.overrides.isEmpty {
                Section {
                    Button("Reset all shortcuts", role: .destructive) { confirmReset = true }
                        .foregroundStyle(AceTheme.Status.failed)
                        .accessibilityIdentifier("keyboard.resetAll")
                }
                .insetRowBackground()
                .transition(.opacity)
            }
        }
        .insetGroupedList()
        .animation(.smooth, value: stored)
        .sensoryFeedback(.selection, trigger: returnSends)
        .sensoryFeedback(.success, trigger: stored)
        .confirmationDialog("Reset all shortcuts?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset all shortcuts", role: .destructive) { stored = "" }
        }
        .navigationTitle("Keyboard").navigationBarTitleDisplayMode(.inline)
    }

    private var groups: [String] {
        PhoneKeymapTable.entries.reduce(into: [String]()) { list, entry in if !list.contains(entry.group) { list.append(entry.group) } }
    }

    @ViewBuilder private func row(_ entry: PhoneKeymapTable.Entry, keymap: PhoneKeymap) -> some View {
        let keys = PhoneKeymap.format(keymap.keys(entry.id))
        if entry.fixed {
            InsetRow(entry.label, systemImage: nil, value: keys)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("keyboard.shortcut.\(entry.id)")
        } else {
            NavigationLink {
                ShortcutEditor(entry: entry, keys: keymap.keys(entry.id))
            } label: {
                InsetRow(entry.label, systemImage: nil, value: keys, subtitle: keymap.isChanged(entry.id) ? "Changed" : nil)
            }
            .accessibilityIdentifier("keyboard.shortcut.\(entry.id)")
        }
    }
}

/// One shortcut's keys: pressed on a hardware keyboard, or set with the modifier switches and
/// the key menu. A clash or a key the system keeps is named under the keys and Save waits.
struct ShortcutEditor: View {
    let entry: PhoneKeymapTable.Entry
    @AppStorage(PhoneKeymap.storageKey) private var stored = ""
    @Environment(\.dismiss) private var dismiss
    @State private var modifiers: Set<String>
    @State private var key: String
    private static let modifierRows = [("ctrl", "Control", "control"), ("alt", "Option", "option"), ("shift", "Shift", "shift"), ("mod", "Command", "command")]

    init(entry: PhoneKeymapTable.Entry, keys: String) {
        self.entry = entry
        var parts = keys.split(separator: "+").map(String.init)
        _key = State(initialValue: parts.popLast() ?? "n")
        _modifiers = State(initialValue: Set(parts))
    }

    var body: some View {
        let keymap = PhoneKeymap(stored: stored)
        let problem = keymap.problem(draft, for: entry.id)
        List {
            Section {
                VStack(spacing: AceTheme.Spacing.xs) {
                    Text(PhoneKeymap.format(draft))
                        .font(.system(.largeTitle, design: .rounded).weight(.medium))
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .contentTransition(.numericText())
                        .accessibilityIdentifier("shortcut.keys")
                    Text(message(problem))
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(problem == nil ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("shortcut.problem")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, AceTheme.Spacing.md)
                .background { KeyCapture { mods, pressed in withAnimation(.smooth) { modifiers = mods; key = pressed } } }
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(Self.modifierRows, id: \.0) { id, name, symbol in
                    InsetRow(systemImage: symbol, title: name) {
                        Toggle(name, isOn: Binding(get: { modifiers.contains(id) }, set: { on in
                            withAnimation(.smooth) { if on { modifiers.insert(id) } else { modifiers.remove(id) } }
                        })).labelsHidden()
                        .accessibilityIdentifier("shortcut.modifier.\(id)")
                    }
                }
                InsetRow(systemImage: "keyboard", title: "Key") {
                    Picker("Key", selection: Binding(get: { key }, set: { next in withAnimation(.smooth) { key = next } })) {
                        ForEach(PhoneKeymapTable.keyOrder, id: \.self) { value in Text(PhoneKeymapTable.keyNames[value] ?? value).tag(value) }
                    }
                    .labelsHidden().pickerStyle(.menu)
                }
                .accessibilityIdentifier("shortcut.key")
            } header: { InsetHeader("Keys") }
            .insetRowBackground()
            if keymap.isChanged(entry.id) {
                Section {
                    Button("Use the default, \(PhoneKeymap.format(entry.keys))") {
                        stored = keymap.binding(entry.id, to: nil).stored
                        dismiss()
                    }
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .accessibilityIdentifier("shortcut.reset")
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: draft)
        .navigationTitle(entry.label).navigationBarTitleDisplayMode(.inline)
        .focusedSceneValue(\.recordingShortcut, true)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    stored = keymap.binding(entry.id, to: PhoneKeymap.normalize(draft)).stored
                    dismiss()
                }
                .disabled(problem != nil || PhoneKeymap.normalize(draft) == PhoneKeymap.normalize(keymap.keys(entry.id)))
                .accessibilityIdentifier("shortcut.save")
            }
        }
    }

    private var draft: String { (["ctrl", "alt", "shift", "mod"].filter(modifiers.contains) + [key]).joined(separator: "+") }
    private func message(_ problem: PhoneKeymap.Problem?) -> String {
        switch problem {
        case nil: " " // Keeps the line's height, so a clash appearing never moves the rows.
        case .invalid: "Add Command or Control."
        case .reserved: "\(PhoneKeymap.format(draft)) is kept by the system."
        case .taken(_, let label): "\(PhoneKeymap.format(draft)) is already \(label)."
        }
    }
}

extension FocusedValues {
    /// True while a shortcut editor is recording keys: the menu bar's commands stand down, so
    /// pressing a taken shortcut records it instead of running it.
    @Entry var recordingShortcut: Bool?
}
