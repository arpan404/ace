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
    @State private var terminals: [TerminalRow] = []
    @State private var selected: String?
    @State private var input = ""
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
            HStack {
                TextField("Terminal input", text: $input).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit { write(input + "\r"); input = "" }.accessibilityIdentifier("terminal.input")
                Button("Send", systemImage: "arrow.up") { write(input + "\r"); input = "" }
                Button("Interrupt", systemImage: "stop.circle") { write("\u{3}") }
            }.disabled(selected == nil || output.exited || !model.canOperate)
        }
        .padding(AceTheme.Spacing.lg)
        .navigationTitle("Terminal").navigationBarTitleDisplayMode(.inline)
        .task { await read() }
        .onDisappear { if let id = output.streamId { model.action(["type": "terminal.unwatch", "id": id]); output.streamId = nil } }
    }
    private func select(_ id: String) {
        guard !id.isEmpty else { return }
        selected = id
        let stream = UUID().uuidString
        output.start(stream)
        model.action(["type": "terminal.watch", "id": stream, "threadId": threadId, "terminalId": id, "offset": 0])
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "terminal.request", "operation": ["op": "list", "threadId": threadId]], as: TerminalReply.self)
            guard reply.ok else { throw ServiceFailure(message: reply.error ?? "Terminal unavailable") }
            terminals = reply.terminals ?? []
            if selected == nil, let first = terminals.first { select(first.id) }
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
    private func write(_ data: String) {
        guard let selected, model.canOperate else { return }
        Task {
            do {
                let reply = try await model.service(["type": "terminal.request", "operation": ["op": "write", "threadId": threadId, "terminalId": selected, "data": data]], as: TerminalReply.self)
                if !reply.ok { problem = reply.error ?? "Terminal input refused" }
            } catch { problem = error.localizedDescription }
        }
    }
}
