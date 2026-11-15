import SwiftUI

/// What a new thread can start from (`forge.start-from`, `bridge/forge-start-from.ts`): the
/// project's open pull requests, failing checks first, and its open issues, as the web lists
/// them under its composer. Nil lists take no space.
struct NewThreadStartFrom: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Identifiable {
        struct Note: Decodable, Sendable, Equatable { let text: String; let failed: Bool }
        let number: Int
        let title: String
        let note: Note?
        let updatedAt: Double?
        let repository: ForgeRepository
        var id: String { "\(repository.owner)/\(repository.name)#\(number)" }
    }
    struct List: Decodable, Sendable, Equatable {
        let label: String
        let total: Int
        let rows: [Row]
        /// Rows shown before Show more; a longer list can be searched.
        let limit: Int
        /// What an empty or failed search says.
        let none: String
    }
    enum Kind: String, Hashable, CaseIterable { case pullRequests, issues }
    let pullRequests: List?
    let issues: List?
    func list(_ kind: Kind) -> List? { kind == .pullRequests ? pullRequests : issues }
}

/// A pick's seed: the first message and the link it carries.
struct NewThreadStartSeed: Decodable, Sendable, Equatable {
    let text: String
    let pullRequest: NewThreadPull?
    let issue: NewThreadIssue?
}

extension ClientModel {
    static func startFromRead(project: String, kind: NewThreadStartFrom.Kind? = nil, search: String = "") -> [String: Any] {
        var read: [String: Any] = ["type": "forge.start-from", "project": project]
        let typed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if let kind, !typed.isEmpty { read["search"] = ["kind": kind.rawValue, "text": typed] }
        return read
    }
    func startFrom(project: String, kind: NewThreadStartFrom.Kind? = nil, search: String = "") async throws -> NewThreadStartFrom {
        try await read(Self.startFromRead(project: project, kind: kind, search: search), as: NewThreadStartFrom.self)
    }
    func startFromPick(project: String, kind: NewThreadStartFrom.Kind, row: NewThreadStartFrom.Row) async throws -> NewThreadStartSeed {
        try await service(["type": "forge.start-from.pick", "project": project, "kind": kind.rawValue,
                           "repository": row.repository.json, "number": row.number], as: NewThreadStartSeed.self)
    }
}

extension NewThreadDraft {
    /// The draft started from a pull request or issue: its first message (after the person's own
    /// words, when there are any) and its link, the one in place of the other.
    mutating func start(from seed: NewThreadStartSeed) {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = typed.isEmpty ? seed.text : text + "\n\n" + seed.text
        issue = seed.issue
        pullRequest = seed.pullRequest
    }
}

/// One list to start from, pushed over the composer: Pull requests and Issues with their totals,
/// the first rows then Show more, and a search on GitHub once the list is longer than that.
/// Picking a row fills the draft from it and goes back.
struct NewThreadStartFromPage: View {
    let client: ClientModel
    let project: String
    let lists: NewThreadStartFrom
    @State var kind: NewThreadStartFrom.Kind
    let pick: (NewThreadStartSeed) -> Void
    @State private var query = ""
    @State private var found: NewThreadStartFrom?
    @State private var showingAll = false
    @State private var picking: String?
    @State private var problem: String?

    private var shown: NewThreadStartFrom.List? {
        query.trimmingCharacters(in: .whitespaces).isEmpty ? lists.list(kind) : found?.list(kind)
    }
    private var kinds: [NewThreadStartFrom.Kind] { NewThreadStartFrom.Kind.allCases.filter { lists.list($0) != nil } }
    private var searchable: Bool { (lists.list(kind)?.total ?? 0) > (lists.list(kind)?.limit ?? 0) || !query.isEmpty }

    var body: some View {
        List {
            if kinds.count > 1 {
                Picker("Start from", selection: $kind) {
                    ForEach(kinds, id: \.self) { each in
                        if let list = lists.list(each) { Text(verbatim: "\(list.label) \(list.total)").tag(each) }
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
                .accessibilityIdentifier("newThread.startFrom.kind")
            }
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
                    .listRowBackground(Color.clear)
            }
            if let list = shown {
                let rows = showingAll ? list.rows : Array(list.rows.prefix(list.limit))
                if rows.isEmpty {
                    Text(list.none).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                        .listRowBackground(Color.clear)
                }
                ForEach(rows) { row in
                    Button { choose(row) } label: { rowView(row) }
                        .buttonStyle(.row)
                        .disabled(picking != nil)
                        .accessibilityIdentifier("newThread.startFrom.\(row.number)")
                        .listRowBackground(Color.clear)
                }
                if !showingAll, list.rows.count > list.limit {
                    Button("Show more") { showingAll = true }
                        .buttonStyle(.textAction())
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("newThread.startFrom.more")
                }
            } else {
                HStack { Spacer(); ProgressView().accessibilityLabel("Searching"); Spacer() }.listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceDesign.Surface.background)
        .modifier(StartFromSearch(on: searchable, query: $query, label: lists.list(kind)?.label ?? ""))
        .navigationTitle("Start from")
        .navigationBarTitleDisplayMode(.inline)
        // GitHub's search allows 30 requests a minute: typing settles a little before it asks.
        .task(id: "\(kind)|\(query)") {
            showingAll = false
            guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { found = nil; return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            found = try? await client.startFrom(project: project, kind: kind, search: query)
        }
    }

    private func rowView(_ row: NewThreadStartFrom.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Text(verbatim: "#\(row.number)").monospacedDigit()
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.subtle)
            QuietRowText(title: row.title, detail: row.note?.text, tone: AceDesign.Ink.primary)
            if picking == row.id { ProgressView().controlSize(.small) }
        }
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.note.map { "#\(row.number) \(row.title), \($0.text)" } ?? "#\(row.number) \(row.title)")
    }

    private func choose(_ row: NewThreadStartFrom.Row) {
        picking = row.id
        problem = nil
        Task {
            defer { picking = nil }
            do { pick(try await client.startFromPick(project: project, kind: kind, row: row)) }
            catch { problem = error.localizedDescription }
        }
    }
}

/// The search field, only on a list longer than its first rows (or while a search is typed).
private struct StartFromSearch: ViewModifier {
    let on: Bool
    @Binding var query: String
    let label: String
    func body(content: Content) -> some View {
        if on { content.searchable(text: $query, prompt: "Search \(label.lowercased())") } else { content }
    }
}
