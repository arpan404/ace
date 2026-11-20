import SwiftUI

/// Where the Files search field looks: file names (quick open) or what the files say.
enum FilesSearchScope: Hashable {
    case names
    case contents
}

/// The Contents scope of the Files search, as the web's Search view: the case, whole word and
/// regex switches, what the search found ("12 results in 3 files"), each file's matching lines
/// under its name with every match marked, and a note when the list was cut. A line opens its
/// file at that line.
struct ContentSearchRows: View {
    @Binding var query: ContentQuery
    /// The bridge's answer for this exact query; nil until the first one arrives.
    let search: ContentSearch?
    let open: (FileTarget) -> Void
    let retry: () -> Void

    var body: some View {
        switches
        if query.pattern.isEmpty {
            EmptyState(systemImage: "text.magnifyingglass", title: "Search in files",
                       line: "Find text in every file of this thread's checkout.")
                .listRowSeparator(.hidden)
                .listRowBackground(AceDesign.Surface.background)
        } else if let error = search?.error, search?.status == "failed" {
            ProblemRow("Couldn't search the files", detail: error, id: "files.contents.problem", retry: retry)
                .listRowSeparator(.hidden)
                .listRowBackground(AceDesign.Surface.background)
        } else if let search, search.status == "done", search.files.isEmpty {
            EmptyState.search(query.pattern).listRowSeparator(.hidden)
                .listRowBackground(AceDesign.Surface.background)
        } else {
            results
        }
    }

    /// The three switches, as the system's toggle buttons.
    private var switches: some View {
        HStack(spacing: AceDesign.Space.related) {
            Toggle(isOn: $query.matchCase) { Text("Aa") }
                .accessibilityLabel("Match case").accessibilityIdentifier("files.contents.case")
            Toggle(isOn: $query.wholeWord) { Text("Word") }
                .accessibilityLabel("Whole word").accessibilityIdentifier("files.contents.word")
            Toggle(isOn: $query.regex) { Text(".*").monospaced() }
                .accessibilityLabel("Regular expression").accessibilityIdentifier("files.contents.regex")
            Spacer(minLength: AceDesign.Space.related)
            if let line = search?.statusLine {
                Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(1).monospacedDigit()
                    .accessibilityIdentifier("files.contents.tally")
            }
        }
        .toggleStyle(.button)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .listRowInsets(EdgeInsets(top: AceDesign.Space.tight, leading: AceDesign.Space.margin,
                                  bottom: AceDesign.Space.tight, trailing: AceDesign.Space.margin))
        .listRowSeparator(.hidden)
        .listRowBackground(AceDesign.Surface.background)
    }

    @ViewBuilder private var results: some View {
        if let search {
            ForEach(search.files) { file in
                Section {
                    ForEach(file.lines) { line in
                        Button { open(FileTarget(path: file.path, line: line.line)) } label: {
                            ContentLineRow(line: line, digits: digits(file))
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin,
                                                  bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                        .listRowBackground(AceDesign.Surface.background)
                        .accessibilityIdentifier("files.contents.\(line.key)")
                    }
                } header: {
                    ContentFileHeader(file: file)
                }
            }
            if let note = search.note {
                Text(note).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .listRowSeparator(.hidden)
                    .listRowBackground(AceDesign.Surface.background)
                    .accessibilityIdentifier("files.contents.note")
            }
        }
        if search == nil || search?.status == "searching", search?.files.isEmpty ?? true {
            SkeletonRows(count: 3, label: "Searching files").listRowSeparator(.hidden)
                .listRowBackground(AceDesign.Surface.background)
                .listRowInsets(EdgeInsets())
        }
    }

    /// Characters the file's widest line number needs, so its previews start in one column.
    private func digits(_ file: ContentSearch.File) -> Int {
        String(file.lines.map(\.line).max() ?? 0).count
    }
}

/// A file's header over its lines: the name, its folder dimmed, and how many matches it has.
private struct ContentFileHeader: View {
    let file: ContentSearch.File
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(file.name).aceMonospace(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary).lineLimit(1).layoutPriority(1)
            if !file.folder.isEmpty {
                Text(file.folder).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: AceDesign.Space.related)
            Text(file.count.formatted()).aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(file.path), \(file.count) \(file.count == 1 ? "result" : "results")")
    }
}

/// A matching line: its number in a column as wide as the file's widest, then its preview.
private struct ContentLineRow: View {
    let line: ContentSearch.Line
    let digits: Int
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Text(String(line.line).leftPadded(to: digits))
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceDesign.Ink.subtle)
            Text(ContentSearch.preview(line.parts))
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: AceDesign.Size.rowLine).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Line \(line.line): \(line.parts.map(\.text).joined())")
    }
}

private extension String {
    /// The string with spaces before it, `width` characters in all.
    func leftPadded(to width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}
