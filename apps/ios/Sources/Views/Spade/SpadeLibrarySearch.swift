import SwiftUI

/// The one search over everything the bot keeps, at the Library's top: a field with ace's
/// magnifier and a clear button once something is typed.
struct SpadeLibrarySearchField: View {
    @Binding var query: String
    let name: String
    @FocusState private var focused: Bool

    var body: some View {
        Section {
            HStack(spacing: AceDesign.Space.related) {
                AceIcon(.magnifyingGlass, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                    .foregroundStyle(AceDesign.Ink.muted)
                TextField("Search what \(name) knows", text: $query)
                    .aceFont(AceDesign.TextRole.rowTitle)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focused)
                    .accessibilityIdentifier("spade.library.search")
                if !query.isEmpty {
                    Button {
                        query = ""
                        focused = true
                    } label: {
                        AceIcon(.xCircle, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear the search")
                }
            }
        }
    }
}

/// What matches the search across the Library, in its own groups (Notes, Pages, Past work,
/// Files, Skills), empty ones left out; nothing anywhere says so once. Read a moment after the
/// person stops typing, and only the latest search's answer shows.
struct SpadeLibraryResults: View {
    let scope: SpadeProfileScope
    let query: String
    @State private var answer: SpadeLibraryAnswer?
    @State private var asked = ""

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Group {
            if let answer, asked == trimmed {
                if let problem = answer.problem {
                    ProblemRow(problem, id: "spade.library.problem") { Task { await search(trimmed) } }
                } else {
                    if answer.failed == true {
                        Section {
                            ProblemRow("Couldn't search all of it.", id: "spade.library.partial") {
                                Task { await search(trimmed) }
                            }
                        }
                    }
                    if let nothing = answer.nothing {
                        Section { SpadeProfileNone(text: nothing) }
                    }
                    ForEach(answer.groups ?? []) { group in
                        Section(group.name) {
                            ForEach(group.rows) { SpadeLibraryRowView(scope: scope, row: $0) }
                            if group.more > 0 { SpadeProfileNone(text: "\(group.more) more on the computer") }
                        }
                    }
                }
            } else {
                Section { SkeletonRows(count: 3, label: "Searching").listRowInsets(EdgeInsets()) }
            }
        }
        .task(id: trimmed) {
            // Typing goes on: wait for a pause before asking.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, !trimmed.isEmpty else { return }
            await search(trimmed)
        }
    }

    private func search(_ words: String) async {
        let read = await scope.client.spadeLibrarySearch(scope.agent, query: words)
        guard words == trimmed else { return }
        answer = read
        asked = words
    }
}

/// A row of a Library list: its icon, title and line, when it changed; past work opens to read.
struct SpadeLibraryRowView: View {
    let scope: SpadeProfileScope
    let row: SpadeLibraryRow

    var body: some View {
        if row.kind == "episode" {
            NavigationLink { SpadeEpisodeView(scope: scope, id: row.id) } label: { content }
        } else {
            content
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.groupGlyphGap) {
            AceIcon(row.icon, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                .foregroundStyle(AceDesign.Ink.muted)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(row.title)
                    .aceFont(row.kind == "note" ? AceDesign.TextRole.message : AceDesign.TextRole.rowTitle)
                    .foregroundStyle(AceDesign.Ink.primary)
                if let line = row.line, !line.isEmpty {
                    Text(line)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            if let at = row.at {
                Text(Date(timeIntervalSince1970: at / 1000), format: .relative(presentation: .named))
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
