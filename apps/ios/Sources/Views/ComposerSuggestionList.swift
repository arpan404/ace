import SwiftUI

/// The `@` or `/` list over the composer: plain rows under hairlines, a quiet group name where the
/// group changes, at most about five rows tall and scrolling past that. Nothing here is boxed;
/// it sits on the grouped surface the composer's attached cards use.
struct ComposerSuggestionList: View {
    let list: SuggestionList?
    let pick: (SuggestionRow) -> Void
    let retry: () -> Void
    /// The most the list may take; nil allows about five rows.
    var maxHeight: CGFloat? = nil
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 48
    @State private var contentHeight: CGFloat = 0
    var body: some View {
        let shape = AceShape.group
        Group {
            switch list?.state {
            case "ready":
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        ForEach(Array((list?.rows ?? []).enumerated()), id: \.element.id) { index, row in
                            if index == 0 || list?.rows[index - 1].group != row.group { header(row.group, first: index == 0) }
                            else { Hairline().padding(.leading, AceTheme.Spacing.lg + 24) }
                            SuggestionRowView(row: row) { pick(row) }
                        }
                    }
                    .padding(.vertical, AceTheme.Spacing.xs)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                // As tall as its rows, never past the room the screen leaves it.
                .frame(height: min(contentHeight, min(rowHeight * 5.5, maxHeight ?? .infinity)))
            case "failed":
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text("Couldn't read suggestions.").foregroundStyle(AceTheme.Colours.mutedForeground)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Button("Try again", action: retry).accessibilityIdentifier("composer.suggestions.retry")
                }
                .line()
            case "empty":
                Text(list?.list == "mention" ? "No files or threads match." : "No commands match.")
                    .foregroundStyle(AceTheme.Colours.mutedForeground).line()
            default:
                Text("Searching…").foregroundStyle(AceTheme.Colours.mutedForeground).line()
            }
        }
        .aceFont(AceTheme.Typography.body, relativeTo: .body)
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerShape(shape)
        .background(GroupedSurface.colour, in: shape)
        .padding(.bottom, AceTheme.Spacing.sm)
        .accessibilityIdentifier("composer.suggestions")
    }
    private func header(_ title: String, first: Bool) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if !first { Hairline() }
            Text(title).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.top, AceTheme.Spacing.xs)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

private extension View {
    /// One status line in the list's place.
    func line() -> some View {
        padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
    }
}

/// One suggestion: its symbol, what it reads and, beneath, its path or description.
private struct SuggestionRowView: View {
    let row: SuggestionRow
    let pick: () -> Void
    var body: some View {
        Button(action: pick) {
            HStack(spacing: AceTheme.Spacing.md) {
                AceIcon(SuggestionSymbol.icon(row), size: 16, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.decoration)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    title.lineLimit(1).foregroundStyle(AceTheme.Colours.foreground)
                    if let detail = row.detail, !detail.isEmpty {
                        Group {
                            if row.icon == "file" {
                                Text(detail).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).truncationMode(.head)
                            } else { Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption) }
                        }
                        .lineLimit(1).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle())
        .accessibilityHint(row.detail ?? "")
        .accessibilityIdentifier("composer.suggestion.\(row.id)")
    }
    @ViewBuilder private var title: some View {
        if row.icon == "file" { Text(row.label).aceMonospace(AceTheme.Typography.body, relativeTo: .body) }
        else { Text(row.label) }
    }
}

/// Each row's symbol: what it points at, or what kind of catalog entry it is.
enum SuggestionSymbol {
    static func icon(_ row: SuggestionRow) -> AceIcon.Name {
        if let action = row.action { return icon(action: action) }
        switch row.icon {
        case "file": return .fileText
        case "thread": return .chatText
        case "tab": return .globe
        case "skill": return .sparkle
        case "plugin": return .plug
        case "agent": return .robot
        case "workflow": return .treeStructure
        case "mcp-tool": return .wrench
        case "builtin": return .paperclip
        default: return .command
        }
    }
    static func icon(action: String) -> AceIcon.Name {
        switch action {
        case "attach": return .paperclip
        case "files": return .at
        case "plan": return .listChecks
        case "goal": return .target
        case "model": return .cpu
        case "review": return .plusMinus
        case "project": return .folder
        default: return action.hasPrefix("automation.run:") ? .lightning : .command
        }
    }
}

/// A prompt's arguments, asked before its reference goes into the message. The bridge checks them
/// with the web's rule and answers with the reference or what to fix.
struct CommandArgumentsSheet: View {
    let row: SuggestionRow
    /// The bridge's answer for this row, once it came.
    let answer: SuggestionArguments?
    let submit: ([String: String]) -> Void
    let cancel: () -> Void
    @State private var values: [String: String] = [:]
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(row.parameters, id: \.name) { parameter in
                        let label = parameter.required ? "\(parameter.name) (required)" : parameter.name
                        if parameter.type == "boolean" {
                            Picker(label, selection: binding(parameter)) {
                                Text("Use default").tag("")
                                Text("Yes").tag("true")
                                Text("No").tag("false")
                            }
                        } else {
                            TextField(label, text: binding(parameter))
                                .keyboardType(parameter.type == "number" ? .decimalPad : .default)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    }
                } footer: {
                    if let error = answer?.error { Text(error).foregroundStyle(AceTheme.StatusText.failed) }
                    else if let detail = row.detail { Text(detail) }
                }
            }
            .navigationTitle(row.label).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add command") { submit(values) }.accessibilityIdentifier("composer.arguments.add")
                }
            }
            .onAppear { values = Dictionary(uniqueKeysWithValues: row.parameters.map { ($0.name, $0.value) }) }
        }
        .presentationDetents([.medium, .large])
    }
    private func binding(_ parameter: SuggestionParameter) -> Binding<String> {
        Binding(get: { values[parameter.name] ?? "" }, set: { values[parameter.name] = $0 })
    }
}
