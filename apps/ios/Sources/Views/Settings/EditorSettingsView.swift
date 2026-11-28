import SwiftUI

/// Settings › Editor: how the phone's code editor writes and looks, kept on this phone as the
/// web keeps its editor settings per device. A change shows in an open editor at once.
///
/// The web's editor settings this phone's editor can't honour stay off the page rather than show
/// a control that does nothing: it draws no indent guides, sticky scroll or whitespace marks,
/// its caret's blink is the system's, and SF Mono is its only face.
struct EditorSettingsView: View {
    @AppStorage(EditorPreferences.autoSaveKey) private var autoSave = EditorAutoSaveMode.off.rawValue
    @AppStorage(EditorPreferences.autoSaveDelayKey) private var autoSaveDelay = EditorPreferences.defaultAutoSaveDelay
    @AppStorage(EditorPreferences.fontSizeKey) private var fontSize = EditorPreferences.defaultFontSize
    @AppStorage(EditorPreferences.lineSpacingKey) private var lineSpacing = EditorPreferences.defaultLineSpacing
    @AppStorage(EditorPreferences.tabSizeKey) private var tabSize = EditorPreferences.defaultTabSize
    @AppStorage(EditorPreferences.insertSpacesKey) private var insertSpaces = true
    @AppStorage(EditorPreferences.wordWrapKey) private var wordWrap = false

    private var mode: EditorAutoSaveMode { EditorAutoSaveMode(rawValue: autoSave) ?? .off }

    var body: some View {
        List {
            Section {
                Picker("Auto save", selection: $autoSave) {
                    ForEach(EditorAutoSaveMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("editor.autoSave")
                if mode == .pause {
                    InsetRow(icon: nil, title: "Save after") {
                        Picker("Save after", selection: $autoSaveDelay) {
                            ForEach(EditorPreferences.autoSaveDelayChoices, id: \.self) { milliseconds in
                                Text(Self.delay(milliseconds)).tag(milliseconds)
                            }
                        }
                        .labelsHidden()
                    }
                    .accessibilityIdentifier("editor.autoSaveDelay")
                    .transition(.opacity)
                }
            } header: { InsetHeader("Saving") } footer: {
                Text("A file another agent changed since you opened it waits for you.")
            }
            .insetRowBackground()
            Section {
                InsetRow(icon: nil, title: "Font size") {
                    Picker("Font size", selection: $fontSize) {
                        ForEach(EditorPreferences.fontSizeChoices, id: \.self) { size in
                            Text("\(size) pt").tag(size)
                        }
                    }
                    .labelsHidden()
                }
                .accessibilityIdentifier("editor.fontSize")
                Picker("Line height", selection: $lineSpacing) {
                    ForEach(EditorPreferences.lineSpacingChoices, id: \.label) { choice in
                        Text(choice.label).tag(choice.value)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("editor.lineSpacing")
            } header: { InsetHeader("Text") }
            .insetRowBackground()
            Section {
                Picker("Tab size", selection: $tabSize) {
                    ForEach(EditorPreferences.tabSizeChoices, id: \.self) { size in
                        Text("\(size)").tag(size)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("editor.tabSize")
                Picker("Indent with", selection: $insertSpaces) {
                    Text("Spaces").tag(true)
                    Text("Tabs").tag(false)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("editor.insertSpaces")
            } header: { InsetHeader("Indentation") } footer: {
                Text("For files whose own indentation can't be detected.")
            }
            .insetRowBackground()
            Section {
                InsetRow(icon: nil, title: "Word wrap") {
                    Toggle("Word wrap", isOn: $wordWrap).labelsHidden()
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("editor.wordWrap")
            } header: { InsetHeader("Display") } footer: {
                Text("While editing, lines always wrap so the caret stays on screen. The phone's editor draws code in SF Mono, without indent guides, sticky scroll or whitespace marks.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: mode)
        .sensoryFeedback(.selection, trigger: wordWrap)
        .navigationTitle("Editor").navigationBarTitleDisplayMode(.inline)
    }

    /// "500 ms", "1 s": the web's words for the pause's lengths.
    static func delay(_ milliseconds: Int) -> String {
        milliseconds < 1000 ? "\(milliseconds) ms" : "\(milliseconds / 1000) s"
    }
}
