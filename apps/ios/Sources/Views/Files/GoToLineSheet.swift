import SwiftUI

/// What the go-to-line field takes, as the web's editor reads it (`go-to-line.tsx`): "line" or
/// "line:column" (a comma works too), both 1-based as the gutter shows them. Pure.
enum GoToLine {
    struct Target: Equatable {
        let line: Int
        let column: Int
    }

    /// The position `typed` names, clamped to the file: a line past the end is the last line and
    /// a column past a line's end lands just after its last character. Nil when it names none.
    /// `lineLength` gets a 1-based line and answers its length without the line break.
    static func parse(_ typed: String, lineCount: Int, lineLength: (Int) -> Int) -> Target? {
        let parts = typed.split(maxSplits: 1, omittingEmptySubsequences: false, whereSeparator: { $0 == ":" || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard let first = parts.first, let wanted = number(first) else { return nil }
        let line = min(max(1, wanted), max(1, lineCount))
        guard parts.count == 2 else { return Target(line: line, column: 1) }
        guard let column = number(parts[1]) else { return nil }
        return Target(line: line, column: min(max(1, column), lineLength(line) + 1))
    }

    /// Digits only; a number too long to hold counts as very large.
    private static func number(_ text: String) -> Int? {
        guard !text.isEmpty, text.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return Int(text) ?? Int.max
    }
}

/// Go to line, from the file's menu or ⌘L: one field taking "line" or "line:column", a quiet
/// line under it saying where Return goes, and Go. The caret lands there and the text view
/// scrolls the line into view above the keyboard.
struct GoToLineSheet: View {
    let lineCount: Int
    let lineLength: @MainActor (Int) -> Int
    let go: (GoToLine.Target) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @FocusState private var focused: Bool

    private var target: GoToLine.Target? { GoToLine.parse(typed, lineCount: lineCount) { lineLength($0) } }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                TextField("Line or line:column", text: $typed)
                    .aceMonospace(AceDesign.TextRole.rowTitle)
                    .keyboardType(.numbersAndPunctuation)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, AceDesign.Space.row)
                    .frame(minHeight: AceDesign.Size.tap)
                    .background(AceTheme.Colours.fill, in: AceShape.field)
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(submit)
                    .accessibilityIdentifier("file.goToLine.field")
                Text(hint)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .monospacedDigit()
                    .accessibilityIdentifier("file.goToLine.hint")
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .padding(.horizontal, AceDesign.Space.margin).padding(.top, AceDesign.Space.related)
            .background(AceTheme.Colours.background)
            .navigationTitle("Go to line")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Go", action: submit).disabled(target == nil)
                        .accessibilityIdentifier("file.goToLine.go")
                }
            }
        }
        .presentationDetents([.height(AceDesign.Size.tap * 4.5)])
        .presentationDragIndicator(.visible)
        .onAppear { focused = true }
    }

    private var hint: String {
        if let target { return "Line \(target.line), column \(target.column)" }
        return "Type a line from 1 to \(max(1, lineCount).formatted())"
    }

    private func submit() {
        guard let target else { return }
        dismiss()
        go(target)
    }
}

/// Go to line on a screen showing a source view: the sheet, and ⌘L (or its rebinding in
/// Settings › Keyboard) on an invisible button, so the key works while reading and editing. The
/// caret moves once the sheet has gone, so the text view can take the keyboard.
struct GoToLineRoute: ViewModifier {
    @Binding var isPresented: Bool
    /// The source view is on screen.
    let enabled: Bool
    let handle: SourceHandle
    @State private var picked: GoToLine.Target?
    @AppStorage(PhoneKeymap.storageKey) private var keys = ""

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $isPresented, onDismiss: go) {
                GoToLineSheet(lineCount: handle.lineCount, lineLength: { handle.lineLength($0) }) { picked = $0 }
            }
            .background {
                if enabled {
                    Button("Go to line") { isPresented = true }
                        .keyboardShortcut(PhoneKeymap(stored: keys).shortcut("goToLine"))
                        .opacity(0)
                        .frame(width: 0, height: 0)
                        .accessibilityHidden(true)
                }
            }
    }

    private func go() {
        guard let target = picked else { return }
        picked = nil
        handle.go(to: target)
    }
}
