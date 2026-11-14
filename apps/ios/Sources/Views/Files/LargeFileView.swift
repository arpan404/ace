import SwiftUI

/// A text file too large to show whole, read a page (about 256 KB) at a time with line numbers,
/// Show more at the foot, find over what is read (Next reads on until the file ends), and Share
/// that saves the whole file to the phone however big it is. A thread's file can be edited a
/// part at a time: each part opens on its own and saves over the bytes it was read from.
struct LargeFileView: View {
    let model: ClientModel
    let scope: FilesScope
    let path: String
    let size: Int?
    /// Parts can be edited and saved (a thread's file, on a pairing that may change it).
    var editable = false
    @AppStorage("files.wrap") private var wrap = false
    @State private var reading = LargeFileText()
    @State private var loading = false
    @State private var failure: String?
    @State private var download: String?
    @State private var finding = false
    @State private var query = ""
    @State private var matches: [LargeFileText.Match] = []
    @State private var current: Int?
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
                        ForEach(reading.parts) { part in
                            if editable { partHeader(part) }
                            ForEach(part.lines.indices, id: \.self) { index in
                                row(number: part.firstLine + index, text: part.lines[index]).id(part.firstLine + index)
                            }
                        }
                        footer
                    }
                    .textSelection(.enabled)
                }
                .onChange(of: current) { _, index in
                    guard let index, matches.indices.contains(index) else { return }
                    withAnimation { scroller.scrollTo(matches[index].line, anchor: .center) }
                }
            }
        }
        .task(id: path) { if reading.parts.isEmpty { await more() } }
        .onChange(of: saved?.phase) { _, phase in if phase == "saved" { UINotificationFeedbackGenerator().notificationOccurred(.success) } }
        .onChange(of: query) { _, _ in refind(keep: false) }
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
                .disabled(matches.isEmpty).accessibilityLabel("Previous match").accessibilityIdentifier("file.large.previous")
            Button { Task { await step(forward: true) } } label: { Image(systemName: "chevron.down") }
                .disabled(query.isEmpty || loading).accessibilityLabel("Next match").accessibilityIdentifier("file.large.next")
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.md)
    }
    private var findCount: String {
        guard !query.isEmpty else { return "" }
        if loading { return "Searching · \(reading.percent)%" }
        let shown = current.map { "\($0 + 1) of \(matches.count)" } ?? "\(matches.count)"
        return reading.done ? shown : "\(shown) so far"
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
        let isCurrent = current.flatMap { matches.indices.contains($0) ? matches[$0].line : nil } == number
        let hit = !query.isEmpty && text.range(of: query, options: .caseInsensitive) != nil
        return HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            Text("\(number + 1)").foregroundStyle(AceTheme.Colours.decoration)
                .frame(minWidth: FileDiffStyle.gutter, alignment: .trailing)
            Text(text.isEmpty ? " " : text).foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(wrap ? nil : 1).fixedSize(horizontal: !wrap, vertical: true)
        }
        .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
        .padding(.trailing, AceTheme.Spacing.lg)
        // The current match as the source view marks a line it was opened at; other matches
        // carry a bar in the gutter's place so they stand apart without a second fill.
        .background(isCurrent ? AceDesign.Surface.lineHighlight : .clear)
        .overlay(alignment: .leading) {
            if hit { Rectangle().fill(AceTheme.Colours.accent).frame(width: AceTheme.Spacing.xxs) }
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

    // MARK: Reading and finding

    @discardableResult private func more() async -> Bool {
        guard !loading, !reading.done else { return false }
        loading = true; defer { loading = false }
        var operation: [String: Any] = ["op": "page", "path": path, "offset": reading.next]
        if let version = reading.version { operation["version"] = version }
        do {
            reading.take(try await model.files(scope, operation, as: FilePageAnswer.self))
            failure = nil
            refind(keep: true)
            return true
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
        return false
    }

    /// After a save the parts' offsets move: read the file again from its start.
    private func reload() async {
        reading = LargeFileText()
        matches = []; current = nil; failure = nil
        await more()
    }

    private func refind(keep: Bool) {
        let previous = current.flatMap { matches.indices.contains($0) ? matches[$0] : nil }
        matches = reading.matches(query)
        current = keep ? previous.flatMap { matches.firstIndex(of: $0) } : nil
    }

    /// Next reads on through the file until a new match turns up or the file ends.
    private func step(forward: Bool) async {
        guard !query.isEmpty else { return }
        if !forward {
            if case .show(let index) = FindStep.previous(from: current, count: matches.count) { current = index }
            return
        }
        while true {
            switch FindStep.next(from: current, count: matches.count, done: reading.done) {
            case .show(let index): current = index; return
            case .none: return
            case .readMore:
                let before = matches.count
                guard await more() else { return }
                if matches.count > before { current = before; return }
            }
        }
    }

    private func save() {
        let id = "dl-\(UUID().uuidString.prefix(20))"
        download = id
        model.action(["type": "files.download", "id": id, "scope": scope.wire, "target": ["kind": "file", "path": path]])
    }
}
