import SwiftUI

/// The hardware-keyboard shortcuts with this phone's rebindings on top. The table and its rules
/// are `@ace/ui-core/phone-keymap`; this reads the generated table and replays the same rules
/// (PhoneKeymapTests checks them against cases the TS decides). Rebindings live on this phone,
/// as JSON under `storageKey`, so every view and the menu bar read them with `@AppStorage`.
struct PhoneKeymap: Equatable {
    static let storageKey = "ace.keyboard.bindings"
    enum Problem: Equatable { case invalid, reserved, taken(id: String, label: String) }

    /// Only well-formed rebindings of rebindable shortcuts.
    let overrides: [String: String]

    init(stored: String) {
        let raw = (try? JSONDecoder().decode([String: String].self, from: Data(stored.utf8))) ?? [:]
        self.init(overrides: raw)
    }
    init(overrides raw: [String: String]) {
        var clean: [String: String] = [:]
        for entry in PhoneKeymapTable.entries where !entry.fixed {
            if let value = raw[entry.id], let keys = Self.normalize(value) { clean[entry.id] = keys }
        }
        overrides = clean
    }

    var stored: String {
        guard let data = try? JSONEncoder().encode(overrides) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
    func keys(_ id: String) -> String {
        overrides[id] ?? PhoneKeymapTable.entries.first { $0.id == id }?.keys ?? ""
    }
    func isChanged(_ id: String) -> Bool { overrides[id] != nil }
    func binding(_ id: String, to keys: String?) -> PhoneKeymap {
        var next = overrides
        next[id] = keys
        return PhoneKeymap(overrides: next)
    }

    /// The SwiftUI shortcut for `id`, nil when its keys can't be expressed.
    func shortcut(_ id: String) -> KeyboardShortcut? { Self.shortcut(keys(id)) }
    static func shortcut(_ keys: String) -> KeyboardShortcut? {
        var parts = keys.split(separator: "+").map(String.init)
        guard let key = parts.popLast(), let equivalent = equivalent(key) else { return nil }
        var modifiers: EventModifiers = []
        if parts.contains("ctrl") { modifiers.insert(.control) }
        if parts.contains("alt") { modifiers.insert(.option) }
        if parts.contains("shift") { modifiers.insert(.shift) }
        if parts.contains("mod") { modifiers.insert(.command) }
        return KeyboardShortcut(equivalent, modifiers: modifiers)
    }
    private static func equivalent(_ key: String) -> KeyEquivalent? {
        switch key {
        case "enter": .return
        case "escape": .escape
        case "tab": .tab
        case "space": .space
        case "backspace": .delete
        case "arrowup": .upArrow
        case "arrowdown": .downArrow
        case "arrowleft": .leftArrow
        case "arrowright": .rightArrow
        default: key.count == 1 ? key.first.map { KeyEquivalent($0) } : nil
        }
    }

    // MARK: The table's rules (`normalizePhoneKeys`, `formatPhoneKeys`, `phoneKeyProblem`)

    private static let modifierOrder = ["ctrl", "alt", "shift", "mod"]
    static func normalize(_ keys: String) -> String? {
        guard !keys.hasSuffix("+") else { return nil }
        var parts = keys.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.popLast(), PhoneKeymapTable.keyNames[key] != nil else { return nil }
        guard parts.allSatisfy(modifierOrder.contains) else { return nil }
        let modifiers = modifierOrder.filter(parts.contains)
        guard modifiers.contains("mod") || modifiers.contains("ctrl") else { return nil }
        return (modifiers + [key]).joined(separator: "+")
    }
    /// "⌃⌘S", "⌘Return", "Esc".
    static func format(_ keys: String) -> String {
        var parts = keys.split(separator: "+").map(String.init)
        guard let key = parts.popLast() else { return keys }
        let glyphs = ["ctrl": "⌃", "alt": "⌥", "shift": "⇧", "mod": "⌘"]
        let prefix = modifierOrder.filter(parts.contains).compactMap { glyphs[$0] }.joined()
        let name = PhoneKeymapTable.keyNames[key] ?? key.uppercased()
        return prefix + name
    }
    func problem(_ keys: String, for id: String) -> Problem? {
        guard let wanted = Self.normalize(keys) else { return .invalid }
        if PhoneKeymapTable.reserved.contains(wanted) { return .reserved }
        let scope = PhoneKeymapTable.entries.first { $0.id == id }?.scope ?? "global"
        let other = PhoneKeymapTable.entries.first { entry in
            entry.id != id && (scope == "global" || entry.scope == "global" || scope == entry.scope)
                && Self.normalize(self.keys(entry.id)) == wanted
        }
        return other.map { .taken(id: $0.id, label: $0.label) }
    }
}

extension View {
    /// Binds `id`'s current keys (Settings › Keyboard) to this control.
    func phoneShortcut(_ id: String) -> some View { modifier(PhoneShortcut(id: id, enabled: true)) }
    /// As `phoneShortcut`, bound only while `enabled`.
    func phoneShortcut(_ id: String, enabled: Bool) -> some View { modifier(PhoneShortcut(id: id, enabled: enabled)) }
}

private struct PhoneShortcut: ViewModifier {
    let id: String
    let enabled: Bool
    @AppStorage(PhoneKeymap.storageKey) private var stored = ""
    func body(content: Content) -> some View {
        content.keyboardShortcut(enabled ? PhoneKeymap(stored: stored).shortcut(id) : nil)
    }
}
