import SwiftUI

private struct TerminalRow: Decodable, Identifiable {
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
struct TerminalView: View {
    let model: ClientModel
    let threadId: String
    /// The terminal to show first, such as the one a script just started.
    var initial: String? = nil
    @State private var terminals: [TerminalRow] = []
    @State private var selected: String?
    @State private var modifiers = TerminalModifiers()
    @State private var queue = TerminalSendQueue()
    /// Moves when the terminal changes, so a reply for the old one can't release the queue.
    @State private var generation = 0
    @State private var typing = false
    @State private var problem: String?
    @State private var busy = false
    private var output: TerminalScreenModel { model.terminal }
    var body: some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            HStack {
                Picker("Terminal", selection: Binding(get: { selected ?? "" }, set: { select($0) })) {
                    Text("Select terminal").tag("")
                    ForEach(terminals) { Text($0.name + ($0.exited ? " · Exited" : "")).tag($0.id) }
                }
                Spacer()
                Button("New", systemImage: "plus") { Task { await create() } }.disabled(!model.canOperate || busy)
            }
            ServiceProblem(message: problem ?? output.problem)
            ScrollViewReader { proxy in
                GeometryReader { area in
                    ScrollView([.horizontal, .vertical]) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(output.text.isEmpty ? "Terminal output appears here." : output.text)
                                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                            Color.clear.frame(height: AceTheme.Dimensions.border).id("tail")
                        }.frame(minWidth: area.size.width, alignment: .topLeading)
                    }
                    .defaultScrollAnchor(.topLeading)
                    .onChange(of: output.offset) { proxy.scrollTo("tail", anchor: .bottom) }
                    .accessibilityIdentifier("terminal.output")
                }
            }
            if output.exited { Text("Process exited").foregroundStyle(AceTheme.Colours.mutedForeground) }
            Group {
                TerminalKeyBar(modifiers: $modifiers) { type([$0]) }
                HStack {
                    TerminalKeyField(
                        enabled: canType, focused: $typing,
                        onText: { type(modifiers.apply(text: $0)) },
                        onDelete: { type([modifiers.apply(key: "Backspace")]) },
                        onReturn: { type([modifiers.apply(key: "Enter")]) },
                        onKey: { type([$0]) }
                    )
                    .frame(height: AceTheme.Dimensions.touchTarget)
                    Button("Interrupt", systemImage: "stop.circle") { type([.key("c", ctrl: true)]) }
                }
            }.disabled(!canType)
        }
        .padding(AceTheme.Spacing.lg)
        .navigationTitle("Terminal").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }
        .onDisappear { if let id = output.streamId { model.action(["type": "terminal.unwatch", "id": id]); output.streamId = nil } }
    }
    private var canType: Bool { selected != nil && !output.exited && model.canOperate }
    private func select(_ id: String) {
        guard !id.isEmpty else { return }
        selected = id
        queue.reset(); generation += 1
        let stream = UUID().uuidString
        output.start(stream)
        model.action(["type": "terminal.watch", "id": stream, "threadId": threadId, "terminalId": id, "offset": 0])
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "list", "threadId": threadId]], as: TerminalReply.self)
            guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Terminal unavailable") }
            terminals = reply.terminals ?? []
            if selected == nil, let initial, terminals.contains(where: { $0.id == initial }) { select(initial) }
            else if selected == nil, let first = terminals.first { select(first.id) }
        } catch { problem = error.localizedDescription }
    }
    private func create() async {
        busy = true; defer { busy = false }
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "open", "threadId": threadId, "cols": 80, "rows": 24]], as: TerminalReply.self)
            guard reply.ok, let terminal = reply.terminal else { throw ServiceFailure(message: reply.error ?? "Couldn't open terminal") }
            await read(); select(terminal.id)
        } catch { problem = error.localizedDescription }
    }
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
