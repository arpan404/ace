import SwiftUI
import UIKit

struct TerminalRow: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let exited: Bool
}
private struct TerminalReply: Decodable {
    let ok: Bool
    let error: String?
    let terminals: [TerminalRow]?
    let terminal: TerminalRow?
}

/// A thread's terminals on the phone: the full emulator surface (colours, cursor addressing,
/// full-screen programs, scrollback), the sessions menu in the title, Find, and a ⋯ menu with
/// Rename, Clear, Copy, Select text, text size, New terminal and End session.
struct TerminalView: View {
    let model: ClientModel
    let threadId: String
    /// The terminal to show first, such as the one a script just started.
    var initial: String? = nil
    @State private var terminals: [TerminalRow] = []
    @State private var selected: String?
    @State private var loaded = false
    @State private var modifiers = TerminalModifiers()
    @State private var queue = TerminalSendQueue()
    /// Moves when the terminal changes, so a reply for the old one can't release the queue.
    @State private var generation = 0
    @State private var typing = false
    @State private var problem: String?
    @State private var busy = false
    @State private var finding = false
    @State private var query = ""
    @State private var matches: [TerminalMatch] = []
    @State private var current: Int?
    @State private var reveal = 0
    @State private var renaming = false
    @State private var newName = ""
    @State private var ending = false
    @State private var selecting = false
    @State private var namesVersion = 0
    @AppStorage("terminal.fontSize") private var fontSize = 12.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var output: TerminalScreenModel { model.terminal }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            if finding {
                TerminalFindBar(query: $query, count: matches.count, index: current,
                                previous: { step(-1) }, next: { step(1) }, done: closeFind)
                    .padding(.vertical, AceTheme.Spacing.xs)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            ServiceProblem(message: problem ?? output.problem)
                .padding(.horizontal, AceTheme.Spacing.lg)
            if selected != nil {
                surface
            } else if loaded {
                Spacer()
                EmptyState(icon: .terminal, title: "No terminals", line: "Open one in this thread's checkout.") {
                    Button("Open a terminal") { Task { await create() } }.disabled(!model.canOperate || busy)
                }
                Spacer()
            } else {
                Spacer()
            }
            if output.exited && selected != nil {
                HStack {
                    Text("Process exited").foregroundStyle(AceTheme.Colours.mutedForeground)
                    Spacer()
                    Button("New terminal") { Task { await create() } }.disabled(!model.canOperate || busy)
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
                .transition(.opacity)
            }
            keys
        }
        .animation(reduceMotion ? .easeInOut(duration: AceTheme.Motion.fast) : .smooth(duration: AceTheme.Motion.standard), value: finding)
        .animation(.easeInOut(duration: AceTheme.Motion.standard), value: output.exited)
        .background(AceTheme.Colours.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .readWhenConnected(model) { await read() }
        .onChange(of: query) { search() }
        .onChange(of: output.revision) { if finding, !query.isEmpty { search(keepCurrent: true) } }
        .onAppear { output.onReply = { reply in type([.text(reply)]) } }
        .onDisappear {
            output.onReply = nil
            if let id = output.streamId { model.action(["type": "terminal.unwatch", "id": id]); output.streamId = nil }
        }
        .alert("Rename terminal", isPresented: $renaming) {
            TextField(currentName, text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { rename() }
        } message: { Text("Shown on this phone. Leave it empty to use “\(shellName)”.") }
        .confirmationDialog("End this terminal session?", isPresented: $ending, titleVisibility: .visible) {
            Button("End session", role: .destructive) { Task { await end() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The shell and anything running in it stop.") }
        .sheet(isPresented: $selecting) { TerminalTextSheet(text: output.text) }
    }

    private var surface: some View {
        TerminalSurface(
            session: output.session, fontSize: fontSize, focused: typing,
            matches: finding ? matches : [], current: current.flatMap { matches.indices.contains($0) ? matches[$0] : nil },
            revealToken: reveal,
            onFit: { columns, rows in fit(columns, rows) },
            onTap: { if canType { typing = true } },
            onScrollKeys: { up, count in type(Array(repeating: .key(up ? "ArrowUp" : "ArrowDown"), count: min(count, 20))) }
        )
        .id(output.streamId)
        .accessibilityLabel("Terminal output")
    }

    private var keys: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            TerminalKeyBar(modifiers: $modifiers) { type([$0]) }
            HStack(spacing: AceTheme.Spacing.sm) {
                TerminalKeyField(
                    enabled: canType, focused: $typing,
                    onText: { type(modifiers.apply(text: $0)) },
                    onDelete: { type([modifiers.apply(key: "Backspace")]) },
                    onReturn: { type([modifiers.apply(key: "Enter")]) },
                    onKey: { type([$0]) }
                )
                .frame(height: AceTheme.Dimensions.touchTarget)
                Button("Interrupt") { type([.key("c", ctrl: true)]) }
                    .fontWeight(.medium).frame(minHeight: 44)
                    .accessibilityIdentifier("terminal.interrupt")
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
        }
        .disabled(!canType)
        .opacity(canType ? 1 : 0.5)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Menu {
                Picker("Terminal", selection: Binding(get: { selected ?? "" }, set: { select($0) })) {
                    ForEach(terminals) { row in
                        Text(label(row) + (row.exited ? " · Exited" : "")).tag(row.id)
                    }
                }
                Divider()
                Button("New terminal", systemImage: "plus") { Task { await create() } }.disabled(!model.canOperate || busy)
            } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Text(selected == nil ? "Terminal" : currentName).fontWeight(.semibold).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .foregroundStyle(AceTheme.Colours.foreground)
            }
            .accessibilityIdentifier("terminal.sessions")
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { finding ? closeFind() : (finding = true) } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Find").accessibilityIdentifier("terminal.find").disabled(selected == nil)
            Menu {
                Button("Rename…", systemImage: "pencil") { newName = TerminalNames.name(thread: threadId, terminal: selected ?? "") ?? ""; renaming = true }
                Button("Clear terminal", systemImage: "eraser") { output.clear(); UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                Button("Copy all output", systemImage: "doc.on.doc") { UIPasteboard.general.string = output.text }
                Button("Select text", systemImage: "text.cursor") { selecting = true }
                Divider()
                Button("Larger text", systemImage: "textformat.size.larger") { fontSize = min(20, fontSize + 1) }.disabled(fontSize >= 20)
                Button("Smaller text", systemImage: "textformat.size.smaller") { fontSize = max(9, fontSize - 1) }.disabled(fontSize <= 9)
                Divider()
                Button("New terminal", systemImage: "plus") { Task { await create() } }.disabled(!model.canOperate || busy)
                Button("End session", systemImage: "power", role: .destructive) { ending = true }.disabled(!model.canOperate)
            } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("Terminal actions").accessibilityIdentifier("terminal.more")
                .disabled(selected == nil)
        }
    }

    // MARK: Names

    private var shellName: String { terminals.first { $0.id == selected }?.name ?? "Terminal" }
    private var currentName: String { _ = namesVersion; return selected.flatMap { TerminalNames.name(thread: threadId, terminal: $0) } ?? shellName }
    private func label(_ row: TerminalRow) -> String { _ = namesVersion; return TerminalNames.name(thread: threadId, terminal: row.id) ?? row.name }
    private func rename() {
        guard let selected else { return }
        TerminalNames.set(newName, thread: threadId, terminal: selected)
        namesVersion += 1
    }

    // MARK: Find

    private func search(keepCurrent: Bool = false) {
        let needle = query
        let session = output.session
        let previous = current.flatMap { matches.indices.contains($0) ? matches[$0] : nil }
        Task.detached(priority: .userInitiated) {
            let found = session.read { TerminalFind.matches(of: needle, in: $0) }
            await MainActor.run {
                guard needle == query else { return }
                matches = found
                if keepCurrent, let previous, let same = found.firstIndex(of: previous) { current = same }
                else {
                    current = found.isEmpty ? nil : found.count - 1
                    if !found.isEmpty { reveal += 1 }
                }
            }
        }
    }
    private func step(_ delta: Int) {
        guard !matches.isEmpty else { return }
        current = ((current ?? 0) + delta + matches.count) % matches.count
        reveal += 1
        UISelectionFeedbackGenerator().selectionChanged()
    }
    private func closeFind() {
        finding = false
        query = ""
        matches = []
        current = nil
    }

    // MARK: Sessions

    private var canType: Bool { selected != nil && !output.exited && model.canOperate }

    private func select(_ id: String) {
        guard !id.isEmpty, id != selected || output.streamId == nil else { return }
        if let old = output.streamId { model.action(["type": "terminal.unwatch", "id": old]) }
        selected = id
        queue.reset(); generation += 1
        closeFind()
        let stream = UUID().uuidString
        output.start(stream)
        model.action(["type": "terminal.watch", "id": stream, "threadId": threadId, "terminalId": id, "offset": 0])
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "list", "threadId": threadId]], as: TerminalReply.self)
            guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Terminal unavailable") }
            terminals = reply.terminals ?? []
            loaded = true
            if let selected, !terminals.contains(where: { $0.id == selected }) { self.selected = nil }
            if selected == nil, let initial, terminals.contains(where: { $0.id == initial }) { select(initial) }
            else if selected == nil, let first = terminals.first(where: { !$0.exited }) ?? terminals.first { select(first.id) }
        } catch { problem = error.localizedDescription; loaded = true }
    }
    private func create() async {
        busy = true; defer { busy = false }
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "open", "threadId": threadId, "cols": 80, "rows": 24]], as: TerminalReply.self)
            guard reply.ok, let terminal = reply.terminal else { throw ServiceFailure(message: reply.error ?? "Couldn't open a terminal") }
            await read(); select(terminal.id)
        } catch { problem = error.localizedDescription }
    }
    private func end() async {
        guard let selected else { return }
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "close", "threadId": threadId, "terminalId": selected]], as: TerminalReply.self)
            guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Couldn't end the session") }
            if let id = output.streamId { model.action(["type": "terminal.unwatch", "id": id]); output.streamId = nil }
            TerminalNames.set(nil, thread: threadId, terminal: selected)
            self.selected = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await read()
        } catch { problem = error.localizedDescription }
    }
    /// The screen was fitted to a new size: tell the PTY so programs lay out for it.
    private func fit(_ columns: Int, _ rows: Int) {
        guard output.fit(columns: columns, rows: rows), let selected else { return }
        Task {
            _ = try? await model.service(["type": "terminal.request", "operation": ["op": "resize", "threadId": threadId, "terminalId": selected, "cols": columns, "rows": rows]], as: TerminalReply.self)
        }
    }

    // MARK: Input

    /// Typed input goes out in order, one write at a time; what arrives meanwhile waits.
    private func type(_ input: [TerminalInput]) {
        guard canType, let batch = queue.add(input) else { return }
        send(batch)
    }
    private func send(_ batch: [TerminalInput]) {
        guard let selected else { return }
        let sent = generation
        let request: [String: Any] = [
            "type": "terminal.input", "threadId": threadId, "terminalId": selected,
            "applicationCursor": output.applicationCursor, "input": batch.map(\.payload),
        ]
        Task {
            do {
                let reply = try await model.service(request, as: TerminalReply.self)
                if !reply.ok { problem = reply.error ?? "Terminal input refused" }
            } catch { problem = error.localizedDescription }
            guard sent == generation, let next = queue.finished() else { return }
            send(next)
        }
    }
}

/// The terminal's text in a plain selectable view, for picking out part of it to copy.
private struct TerminalTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text.isEmpty ? " " : text)
                    .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(AceTheme.Spacing.lg)
            }
            .defaultScrollAnchor(.bottom)
            .navigationTitle("Select text").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDragIndicator(.visible)
    }
}
