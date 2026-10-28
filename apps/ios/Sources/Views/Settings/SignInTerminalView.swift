import SwiftUI

/// What a sign-in asks for when the CLI must finish it in its own terminal (`manual` on the
/// daemon's sign-in progress): the instruction, the command, and its live terminal when open.
struct LoginManual: Decodable, Equatable {
    let command: String
    let instruction: String
    let terminalId: String?
}

/// The step of a sign-in that runs in the CLI's own live terminal on the computer: its
/// instruction, then Open terminal, which shows the terminal here to type into.
struct SignInTerminalRows: View {
    let model: ClientModel
    let session: String
    let manual: LoginManual
    @State private var terminalId: String?
    @State private var problem: String?
    @State private var opening = false

    var body: some View {
        Text(manual.instruction)
        Text(manual.command).monospaced().textSelection(.enabled).foregroundStyle(AceTheme.Colours.mutedForeground)
        if let id = terminalId ?? manual.terminalId {
            NavigationLink { SignInTerminalView(model: model, terminalId: id) } label: { Text("Open terminal").foregroundStyle(AceTheme.Colours.accent) }
                .accessibilityIdentifier("signin.terminal")
        } else {
            Button(opening ? "Opening…" : "Open terminal") { open() }.disabled(opening)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
        }
        ServiceProblem(message: problem)
    }

    private func open() {
        opening = true; problem = nil
        Task {
            defer { opening = false }
            do {
                let reply = try await model.service(["type": "provider.login.terminal", "session": session], as: LoginReply.self)
                guard reply.result.ok, let id = reply.result.progress?.manual?.terminalId else {
                    throw ServiceFailure(message: "The terminal couldn't open. Run the command in a terminal on the computer.")
                }
                terminalId = id
            } catch { problem = error.localizedDescription }
        }
    }
}

/// A CLI's live sign-in terminal: its output, the key bar and a keyboard field. It belongs to
/// this connection, so it closes when the phone disconnects, and keeps no history.
struct SignInTerminalView: View {
    let model: ClientModel
    let terminalId: String
    @State private var modifiers = TerminalModifiers()
    @State private var queue = TerminalSendQueue()
    @State private var typing = false
    @State private var problem: String?
    private var output: TerminalScreenModel { model.terminal }

    var body: some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            ServiceProblem(message: problem ?? output.problem)
            ScrollViewReader { proxy in
                GeometryReader { area in
                    ScrollView([.horizontal, .vertical]) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(output.text.isEmpty ? "Waiting for the CLI…" : output.text)
                                .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).textSelection(.enabled)
                            Color.clear.frame(height: AceTheme.Dimensions.border).id("tail")
                        }.frame(minWidth: area.size.width, alignment: .topLeading)
                    }
                    .defaultScrollAnchor(.topLeading)
                    .onChange(of: output.offset) { proxy.scrollTo("tail", anchor: .bottom) }
                    .accessibilityIdentifier("signin.terminal.output")
                }
            }
            if output.exited { Text("The CLI finished. Go back to see the result.").foregroundStyle(AceTheme.Colours.mutedForeground) }
            Group {
                TerminalKeyBar(modifiers: $modifiers) { type([$0]) }
                TerminalKeyField(
                    enabled: canType, focused: $typing,
                    onText: { type(modifiers.apply(text: $0)) },
                    onDelete: { type([modifiers.apply(key: "Backspace")]) },
                    onReturn: { type([modifiers.apply(key: "Enter")]) },
                    onKey: { type([$0]) }
                )
                .frame(height: AceTheme.Dimensions.touchTarget)
            }.disabled(!canType)
        }
        .padding(AceTheme.Spacing.lg)
        .navigationTitle("Sign-in terminal").navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: watch)
        .onDisappear { if let id = output.streamId { model.action(["type": "terminal.unwatch", "id": id]); output.streamId = nil } }
    }

    private var canType: Bool { !output.exited && model.canOperate }
    private func watch() {
        let stream = UUID().uuidString
        queue.reset()
        output.start(stream)
        model.action(["type": "terminal.watch", "id": stream, "terminalId": terminalId, "offset": 0])
        typing = true
    }
    private func type(_ input: [TerminalInput]) {
        guard canType, let batch = queue.add(input) else { return }
        send(batch)
    }
    private func send(_ batch: [TerminalInput]) {
        let request: [String: Any] = [
            "type": "terminal.input", "terminalId": terminalId,
            "applicationCursor": output.applicationCursor, "input": batch.map(\.payload),
        ]
        Task {
            do {
                let reply = try await model.service(request, as: SignInTerminalReply.self)
                if !reply.ok { problem = reply.error ?? "The terminal didn't take that input." }
            } catch { problem = error.localizedDescription }
            guard let next = queue.finished() else { return }
            send(next)
        }
    }
}

private struct SignInTerminalReply: Decodable { let ok: Bool; let error: String? }
