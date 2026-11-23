import SwiftUI

/// The bot's terminal (web's `bot-terminal.tsx`), attached to its PTY in the phone's terminal
/// view. Everyone sees the same shell: the bot's commands show in it. Keys and the screen's size
/// go to it only while the person may act (cowork with no take-over, or exclusive while they
/// drive). The stream follows only while this page shows with the app in front.
struct SpadeComputerTerminal: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    let name: String
    let face: SpadeModel.Face
    @Environment(\.scenePhase) private var scene
    @AppStorage("terminal.fontSize") private var fontSize = 12.0
    @State private var modifiers = TerminalModifiers()
    @State private var queue = TerminalSendQueue()
    @State private var typing = false
    @State private var problem: String?
    /// This page's stream id on the shared terminal model, while it follows.
    @State private var stream: String?
    private var output: TerminalScreenModel { model.terminal }
    private var canType: Bool { watch.mayAct(model) }

    var body: some View {
        VStack(spacing: AceDesign.Space.related) {
            if watch.state?.surface("terminal")?.endingStuck == true {
                Text("Still ending the last command")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceDesign.Space.margin)
            }
            ServiceProblem(message: problem ?? output.problem)
            TerminalSurface(
                session: output.session, fontSize: fontSize, focused: typing,
                matches: [], current: nil, revealToken: 0,
                onFit: { columns, rows in fit(columns, rows) },
                onTap: { if canType { typing = true } },
                onScrollKeys: { up, count in type(Array(repeating: .key(up ? "ArrowUp" : "ArrowDown"), count: min(count, 20))) }
            )
            .id(output.streamId)
            .accessibilityLabel("\(name)'s terminal")
            .accessibilityIdentifier("spade.terminal.output")
            keys
            SpadeDriveLineView(model: model, watch: watch, kind: "terminal", face: face)
                .padding(.horizontal, AceDesign.Space.margin)
        }
        .padding(.bottom, AceDesign.Space.related)
        .background(AceTheme.Colours.background)
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .followsComputer(watch, model: model)
        .task(id: "\(scene)-\(model.connection)") {
            // In the background or away from the daemon nothing streams.
            guard scene == .active, model.connection == "ready" else { unwatch(); return }
            guard stream == nil else { return }
            let id = UUID().uuidString
            stream = id
            queue.reset()
            model.spadeTerminalWatch(watch.agent, stream: id)
        }
        .onAppear { output.onReply = { reply in type([.text(reply)]) } }
        .onDisappear { output.onReply = nil; unwatch() }
    }

    private var keys: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            TerminalKeyBar(modifiers: $modifiers) { type([$0]) }
            TerminalKeyField(
                enabled: canType, focused: $typing,
                onText: { type(modifiers.apply(text: $0)) },
                onDelete: { type([modifiers.apply(key: "Backspace")]) },
                onReturn: { type([modifiers.apply(key: "Enter")]) },
                onKey: { type([$0]) }
            )
            .frame(height: AceDesign.Size.tap)
            .padding(.horizontal, AceTheme.Spacing.lg)
        }
        .disabled(!canType)
        .opacity(canType ? 1 : AceDesign.Ink.dimmedOpacity)
    }

    private func unwatch() {
        guard let id = stream else { return }
        stream = nil
        model.spadeTerminalUnwatch(stream: id)
    }

    /// The screen was fitted to a new size: Spade's PTY takes it while the person may type.
    private func fit(_ columns: Int, _ rows: Int) {
        guard output.fit(columns: columns, rows: rows), canType else { return }
        Task {
            _ = await model.spadeComputer(["type": "spade.terminal.resize", "agentId": watch.agent, "cols": columns, "rows": rows],
                                          failing: "")
        }
    }

    /// Typed input goes out in order, one write at a time; what arrives meanwhile waits.
    private func type(_ input: [TerminalInput]) {
        guard canType, let batch = queue.add(input) else { return }
        send(batch)
    }

    private func send(_ batch: [TerminalInput]) {
        let request: [String: Any] = [
            "type": "spade.terminal.input", "agentId": watch.agent,
            "applicationCursor": output.applicationCursor, "input": batch.map(\.payload),
        ]
        Task {
            let reply = await model.spadeComputer(request, failing: "That didn't reach the terminal")
            problem = reply.problem
            guard let next = queue.finished() else { return }
            send(next)
        }
    }
}
