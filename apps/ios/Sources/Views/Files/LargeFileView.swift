import SwiftUI

/// A text file too large to show whole, read a page (about 256 KB) at a time with line numbers.
/// The phone holds a few parts at once (`LargeFileText.window`): Show more reads on and lets the
/// first part go, Show earlier reads back. Find searches the whole file a page at a time without
/// holding it (`LargeFileFind`) and jumps the shown parts to each match. Share saves the whole file
/// to the phone however big it is. A thread's file can be edited a part at a time: each part
/// opens on its own and saves over the bytes it was read from. Lines changed since the last
/// commit carry the source view's bars: green at the gutter's edge, a red rule above a removal.
struct LargeFileView: View {
    let model: ClientModel
    let scope: FilesScope
    let path: String
    let size: Int?
    /// Parts can be edited and saved (a thread's file, on a pairing that may change it).
    var editable = false
    /// Lines changed since the last commit, by 1-based line: "added", "modified" or "removed".
    var marks: [Int: String] = [:]
    @AppStorage("files.wrap") private var wrap = false
    @State private var reading = LargeFileText()
    @State private var loading = false
    @State private var failure: String?
    @State private var download: String?
    @State private var finding = false
    @State private var query = ""
    @State private var search = LargeFileFind(query: "")
    @State private var searching = false
    /// The match shown: its overall index and where it is.
    @State private var current: Int?
    @State private var shown: LargeFileFind.Hit?
    @State private var editingPart: LargeFileText.Part?
    @FocusState private var findFocused: Bool
    private var saved: FileDownload? { download.flatMap { model.files.downloads[$0] } }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            header
            if finding { findBar }
            ScrollViewReader { scroller in
                ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        if reading.hasEarlier { earlier }
                        ForEach(reading.parts) { part in
                            if editable { partHeader(part) }
                            ForEach(part.lines.indices, id: \.self) { index in
                                row(number: part.firstLine + index, text: part.lines[index]).id(Self.rowId(page: part.offset, index: index))
                            }
                        }
                        footer
                    }
                    .textSelection(.enabled)
                }
                .onChange(of: shown) { _, hit in
                    guard let hit else { return }
                    withAnimation { scroller.scrollTo(Self.rowId(page: hit.page, index: hit.line - hit.pageLine), anchor: .center) }
                }
            }
        }
        .task(id: path) { if reading.parts.isEmpty { await more() } }
        .onChange(of: saved?.phase) { _, phase in if phase == "saved" { UINotificationFeedbackGenerator().notificationOccurred(.success) } }
        .onChange(of: query) { _, next in search = LargeFileFind(query: next); current = nil; shown = nil }
        .onDisappear { if let download { model.action(["type": "files.download.done", "id": download]) } }
        .sheet(item: $editingPart) { part in
            FilePartEditor(model: model, scope: scope, path: path, part: part, version: reading.version ?? "") { saved in
                editingPart = nil
                if saved { Task { await reload() } }
            }
        }
    }

    private var header: some View {
        HStack {
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(size ?? 0), countStyle: .file)) · read in parts")
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            Spacer()
            Button(finding ? "Done" : "Find") {
                finding.toggle()
                findFocused = finding
                if !finding { query = "" }
            }
            .accessibilityIdentifier("file.large.find")
            if let saved, saved.phase == "saved", let file = saved.filePath {
                ShareLink(item: URL(fileURLWithPath: file)) { Text("Share") }
            } else if let saved, saved.phase == "saving" {
                Text("Saving \(ByteCountFormatter.string(fromByteCount: Int64(saved.received), countStyle: .file))").monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            } else {
                Button("Save to phone") { save() }.accessibilityIdentifier("file.large.save")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(AceTheme.Spacing.lg)
    }

    /// The find field with the match count and Previous and Next.
    private var findBar: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            TextField("Find in file", text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($findFocused)
                .submitLabel(.search)
                .onSubmit { Task { await step(forward: true) } }
                .accessibilityIdentifier("file.large.query")
            Text(findCount).monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                .accessibilityIdentifier("file.large.count")
            Button { Task { await step(forward: false) } } label: { Image(systemName: "chevron.up") }
                .disabled(search.found == 0 || searching).accessibilityLabel("Previous match").accessibilityIdentifier("file.large.previous")
            Button { Task { await step(forward: true) } } label: { Image(systemName: "chevron.down") }
                .disabled(query.isEmpty || searching).accessibilityLabel("Next match").accessibilityIdentifier("file.large.next")
            // The match's part header is often scrolled off once find centres the match; its
            // Edit stays here, beside the match it opens on.
            if editable, let part = matchPart {
                Button("Edit") { editingPart = part }
                    .buttonStyle(.textAction())
                    .accessibilityLabel("Edit lines \(part.firstLine + 1) to \(part.firstLine + max(part.lines.count, 1))")
                    .accessibilityIdentifier("file.large.find.edit")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.md)
    }
    /// The part holding the match shown, when it is held.
    private var matchPart: LargeFileText.Part? {
        shown.flatMap { hit in reading.parts.first { $0.offset == hit.page } }
    }
    /// A row's place: its part and its line within the part. A long line cut across parts shows
    /// as a row in each, under the same line number, so the number alone isn't unique.
    private static func rowId(page: Int, index: Int) -> String { "\(page):\(index)" }

    private var findCount: String {
        guard !query.isEmpty else { return "" }
        if searching, let next = search.next, let total = size, total > 0 { return "Searching · \(min(99, next.page * 100 / total))%" }
        if search.complete && search.found == 0 { return "No matches" }
        let count = search.complete ? "\(search.found)" : "\(search.found)+"
        return current.map { "\($0 + 1) of \(count)" } ?? count
    }

    private var earlier: some View {
        Button {
            Task { await readEarlier() }
        } label: {
            Text("Show earlier lines").frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .accessibilityIdentifier("file.large.earlier")
    }

    private func partHeader(_ part: LargeFileText.Part) -> some View {
        HStack {
            Text("Lines \((part.firstLine + 1).formatted())–\((part.firstLine + max(part.lines.count, 1)).formatted())")
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            Spacer()
            Button("Edit") { editingPart = part }
                .buttonStyle(.textAction())
                .accessibilityLabel("Edit lines \(part.firstLine + 1) to \(part.firstLine + part.lines.count)")
                .accessibilityIdentifier("file.large.edit.\(part.offset)")
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.secondaryBackground)
    }

    private func row(number: Int, text: String) -> some View {
        // A CRLF line keeps its `\r` for saving; it isn't drawn.
        let drawn = text.unicodeScalars.last == "\r" ? String(text.unicodeScalars.dropLast()) : text
        let hit = !query.isEmpty && drawn.range(of: query, options: .caseInsensitive) != nil
        let mark = marks[number + 1]
        return HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            Text("\(number + 1)").foregroundStyle(AceTheme.Colours.decoration)
                .frame(minWidth: FileDiffStyle.gutter, alignment: .trailing)
                .padding(.trailing, AceTheme.Spacing.xs)
                .overlay(alignment: .trailing) {
                    if mark == "added" || mark == "modified" {
                        Rectangle().fill(AceTheme.StatusText.done).frame(width: FileDiffStyle.bar)
                    }
                }
                .accessibilityValue(mark.flatMap(LineMark.words) ?? "")
            Text(drawn.isEmpty ? " " : drawn).foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(wrap ? nil : 1).fixedSize(horizontal: !wrap, vertical: true)
        }
        .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
        .padding(.trailing, AceTheme.Spacing.lg)
        // The current match as the source view marks a line it was opened at; other matches
        // carry a bar in the gutter's place so they stand apart without a second fill.
        .background(shown?.line == number ? AceDesign.Surface.lineHighlight : .clear)
        .overlay(alignment: .leading) {
            if hit { Rectangle().fill(AceTheme.Colours.accent).frame(width: AceTheme.Spacing.xxs) }
        }
        .overlay(alignment: .top) {
            if mark == "removed" { Rectangle().fill(AceTheme.StatusText.failed).frame(height: AceDesign.Size.rail) }
        }
    }

    @ViewBuilder private var footer: some View {
        if let failure {
            Text(failure).foregroundStyle(AceTheme.StatusText.failed).padding(AceTheme.Spacing.lg)
            Button("Retry") { Task { await more() } }.buttonStyle(.textAction()).disabled(loading)
        } else if loading {
            ProgressView().frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine)
        } else if !reading.done {
            Button {
                Task { await more() }
            } label: {
                Text("Show more · \(reading.percent)% read").frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowLine)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file.large.more")
        }
    }

    // MARK: Reading

    private func page(at offset: Int) async throws -> FilePageAnswer {
        var operation: [String: Any] = ["op": "page", "path": path, "offset": offset]
        if let version = reading.version { operation["version"] = version }
        return try await model.files(scope, operation, as: FilePageAnswer.self)
    }

    private func more() async {
        guard !loading, !reading.done else { return }
        loading = true; defer { loading = false }
        do {
            reading.take(try await page(at: reading.next))
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    private func readEarlier() async {
        guard !loading, let offset = reading.earlierStart else { return }
        loading = true; defer { loading = false }
        do {
            reading.takeEarlier(try await page(at: offset))
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    /// After a save the parts' offsets move: read the file again from its start.
    private func reload() async {
        reading = LargeFileText()
        search = LargeFileFind(query: query)
        current = nil; shown = nil; failure = nil
        await more()
    }

    // MARK: Finding

    /// Next or Previous: search on a page at a time until the match is held, then show it.
    private func step(forward: Bool) async {
        guard !query.isEmpty, !searching else { return }
        searching = true; defer { searching = false }
        do {
            var plan = forward ? FindStep.next(from: current, in: search) : FindStep.previous(from: current, in: search)
            for _ in 0..<2 {
                switch plan {
                case .show(let index):
                    return try await show(index)
                case .none:
                    return
                case .search(let advance):
                    if advance { search.advance() }
                    let before = search.found
                    while search.found == before, !search.complete, !search.full { try await searchPage() }
                    if search.hit(before) != nil { return try await show(before) }
                    // Searched to the end with nothing new: round to the first match.
                    plan = FindStep.next(from: current, in: search)
                case .rewind(let index):
                    search.rewind()
                    while search.hit(index) == nil {
                        if search.full { search.advance(); continue }
                        if search.complete { return }
                        try await searchPage()
                    }
                    return try await show(index)
                }
            }
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    /// Search the page the search waits on: from the parts held when it is one, else read.
    private func searchPage() async throws {
        guard let resume = search.next else { return }
        let read: FilePageAnswer
        if let held = reading.parts.first(where: { $0.offset == resume.page }) {
            read = held.page(size: reading.size, version: reading.version ?? "")
        } else {
            read = try await page(at: resume.page)
        }
        search.take(read)
        if let next = search.next, next.position == 0 { reading.learn(.init(offset: next.page, firstLine: next.firstLine)) }
    }

    /// Show a held match, reading its page into view when the parts shown don't hold it.
    private func show(_ index: Int) async throws {
        guard let hit = search.hit(index) else { return }
        if !reading.parts.contains(where: { $0.offset == hit.page }) {
            reading.jump(to: try await page(at: hit.page), firstLine: hit.pageLine)
        }
        current = index
        shown = hit
    }

    private func save() {
        let id = "dl-\(UUID().uuidString.prefix(20))"
        download = id
        model.action(["type": "files.download", "id": id, "scope": scope.wire, "target": ["kind": "file", "path": path]])
    }
}
