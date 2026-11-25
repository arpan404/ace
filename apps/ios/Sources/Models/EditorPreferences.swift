import Foundation

/// Whether the phone's editor writes a file by itself (Settings › Editor). The phone's editor has
/// no second window for focus to leave into, so the web's third mode stays off its page: a file
/// saves after typing rests, or when the person taps Save.
enum EditorAutoSaveMode: String, CaseIterable, Sendable {
    case off, pause

    var label: String {
        switch self {
        case .off: "Off"
        case .pause: "After a pause"
        }
    }
}

/// How the phone's code editor looks and saves (Settings › Editor): the web's device settings,
/// kept on this phone as the web keeps them per device. Each field falls back on its own, so a
/// record an older or newer build wrote keeps every value this build still understands.
struct EditorPreferences: Equatable, Sendable {
    static let autoSaveKey = "editor.autoSave"
    static let autoSaveDelayKey = "editor.autoSaveDelay"
    static let fontSizeKey = "editor.fontSize"
    static let lineSpacingKey = "editor.lineSpacing"
    static let tabSizeKey = "editor.tabSize"
    static let insertSpacesKey = "editor.insertSpaces"
    /// The key the file viewer's Wrap lines has used since it shipped; the Editor page shows the
    /// same preference as Word wrap, so one preference keeps one key.
    static let wordWrapKey = "files.wrap"

    static let fontSizeChoices = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24]
    static let lineSpacingChoices: [(value: Double, label: String)] = [
        (1.45, "Tight"), (1.7, "Normal"), (2, "Relaxed"),
    ]
    static let tabSizeChoices = [2, 4, 8]
    static let autoSaveDelayChoices = [500, 1000, 2000, 5000]

    static let defaultAutoSaveDelay = 1000
    static let defaultFontSize = 13
    static let defaultLineSpacing = 1.7
    static let defaultTabSize = 2

    var autoSave: EditorAutoSaveMode
    /// With "After a pause": how long typing rests before the file saves, in milliseconds.
    var autoSaveDelay: Int
    var fontSize: Int
    /// A row's height as a multiple of the font size.
    var lineSpacing: Double
    /// For files whose own indentation can't be detected.
    var tabSize: Int
    var insertSpaces: Bool
    var wordWrap: Bool

    init(
        autoSave: EditorAutoSaveMode = .off,
        autoSaveDelay: Int = Self.defaultAutoSaveDelay,
        fontSize: Int = Self.defaultFontSize,
        lineSpacing: Double = Self.defaultLineSpacing,
        tabSize: Int = Self.defaultTabSize,
        insertSpaces: Bool = true,
        wordWrap: Bool = false
    ) {
        self.autoSave = autoSave
        self.autoSaveDelay = min(max(autoSaveDelay, 200), 60_000)
        self.fontSize = min(max(fontSize, 8), 40)
        self.lineSpacing = min(max(lineSpacing, 1), 3)
        self.tabSize = min(max(tabSize, 1), 16)
        self.insertSpaces = insertSpaces
        self.wordWrap = wordWrap
    }

    /// This phone's saved preferences; anything missing or unreadable takes its default.
    init(defaults: UserDefaults = .standard) {
        self.init(
            autoSave: EditorAutoSaveMode(rawValue: defaults.string(forKey: Self.autoSaveKey) ?? "") ?? .off,
            autoSaveDelay: defaults.object(forKey: Self.autoSaveDelayKey) as? Int ?? Self.defaultAutoSaveDelay,
            fontSize: defaults.object(forKey: Self.fontSizeKey) as? Int ?? Self.defaultFontSize,
            lineSpacing: defaults.object(forKey: Self.lineSpacingKey) as? Double ?? Self.defaultLineSpacing,
            tabSize: defaults.object(forKey: Self.tabSizeKey) as? Int ?? Self.defaultTabSize,
            insertSpaces: defaults.object(forKey: Self.insertSpacesKey) as? Bool ?? true,
            wordWrap: defaults.bool(forKey: Self.wordWrapKey)
        )
    }

    /// What the editor draws with when its screen is built: the preferences saved on this phone.
    static func current(from defaults: UserDefaults = .standard) -> EditorPreferences {
        EditorPreferences(defaults: defaults)
    }

    /// A row's height in points for a font of `size`: never tighter than the glyphs, rounded as
    /// the web's `editorLineHeight` rounds it.
    func lineHeight(forFontSize size: CGFloat) -> CGFloat {
        max(size + 2, (size * CGFloat(lineSpacing)).rounded())
    }

    /// What one indent step writes: spaces when Indent with is Spaces, else a tab.
    var indent: String {
        insertSpaces ? String(repeating: " ", count: tabSize) : "\t"
    }
}
