import SwiftUI

/// Find in the terminal: the query, "3 of 12", Previous and Next, and Done. Matches are found off
/// the main thread over history and screen; the current one is brought into view.
struct TerminalFindBar: View {
    @Binding var query: String
    let count: Int
    let index: Int?
    let previous: () -> Void
    let next: () -> Void
    let done: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            TextField("Find", text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit(next)
                .focused($focused)
                .padding(.horizontal, AceTheme.Spacing.md)
                .frame(minHeight: 36)
                .background(AceTheme.Colours.fill, in: Capsule())
                .accessibilityIdentifier("terminal.find.field")
            Text(summary)
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).monospacedDigit()
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1).fixedSize()
                .accessibilityIdentifier("terminal.find.count")
            Button(action: previous) { Image(systemName: "chevron.up").frame(width: 44, height: 44) }
                .accessibilityLabel("Previous match").disabled(count == 0)
            Button(action: next) { Image(systemName: "chevron.down").frame(width: 44, height: 44) }
                .accessibilityLabel("Next match").disabled(count == 0)
                .accessibilityIdentifier("terminal.find.next")
            Button("Done", action: done).fontWeight(.medium)
                .frame(minHeight: 44)
                .accessibilityIdentifier("terminal.find.done")
        }
        .buttonStyle(.plain)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceTheme.Spacing.lg)
        .onAppear { focused = true }
    }

    private var summary: String {
        if query.isEmpty { return "" }
        if count == 0 { return "No matches" }
        let shown = count >= TerminalFind.limit ? "\(count)+" : "\(count)"
        return index.map { "\($0 + 1) of \(shown)" } ?? shown
    }
}

/// Names given to terminals on this phone, by thread and terminal. The daemon has no name to
/// change, so an empty name brings back the shell's own.
enum TerminalNames {
    private static let key = "terminal.names"

    static func name(thread: String, terminal: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?["\(thread)/\(terminal)"]
    }

    static func set(_ name: String?, thread: String, terminal: String) {
        var names = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        names["\(thread)/\(terminal)"] = trimmed.isEmpty ? nil : String(trimmed.prefix(80))
        // Bounded like any per-device list: the oldest names go first.
        if names.count > 200 { names = Dictionary(uniqueKeysWithValues: names.suffix(200).map { ($0.key, $0.value) }) }
        UserDefaults.standard.set(names, forKey: key)
    }
}
