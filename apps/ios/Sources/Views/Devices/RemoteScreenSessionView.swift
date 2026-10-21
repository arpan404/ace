import SwiftUI

struct RemoteScreenSessionView: View {
    let model: ClientModel
    let screen: RemoteScreen
    let sessionId: String
    @Environment(\.scenePhase) private var scene
    @State private var text = ""
    @State private var typing = false
    @State private var drag = false
    private var state: RemoteScreenState? { screen.state(sessionId) }
    private var controlling: Bool { model.connection == "ready" && model.canOperate && screen.controls(sessionId) }
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            if model.connection != "ready" { InboxConnectionBanner(connection: model.connection, retry: model.retry).padding(AceTheme.Spacing.md) }
            if state?.lifecycle == "live" {
                MacScreenSurface(live: screen.live, interactive: controlling, input: gesture).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("App isn't live", systemImage: "macwindow", description: Text(state?.error ?? state?.lifecycle.capitalized ?? "The session has ended."))
            }
            ServiceProblem(message: screen.problem)
            HStack {
                if model.canOperate {
                    Button(controlling ? "Release control" : "Take control") {
                        Task { if controlling { await screen.release(model, id: sessionId) } else { await screen.takeControl(model, id: sessionId) } }
                    }.disabled(screen.busy || state?.lifecycle != "live")
                }
                Spacer()
                menu
            }.frame(minHeight: AceTheme.Dimensions.touchTarget).padding(.horizontal, AceTheme.Spacing.lg)
            if controlling {
                HStack {
                    TextField("Type in app", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit(type)
                    Button("Send", action: type).disabled(text.isEmpty || typing)
                }.frame(minHeight: AceTheme.Dimensions.touchTarget).padding(.horizontal, AceTheme.Spacing.lg)
            }
        }
        .navigationTitle(state?.title ?? "Mac app").navigationBarTitleDisplayMode(.inline)
        .task(id: "\(scene)-\(model.connection)") {
            guard scene == .active, model.connection == "ready" else { screen.unwatch(model, id: sessionId); return }
            await screen.refresh(model); await screen.watch(model, id: sessionId)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await screen.refresh(model)
            }
        }
        .onDisappear { screen.unwatch(model, id: sessionId) }
    }
    private var menu: some View {
        Menu {
            Toggle("Drag instead of scroll", isOn: $drag).disabled(!controlling)
            if controlling {
                Button("Return") { key("Return") }
                Button("Escape") { key("Escape") }
                Button("Tab") { key("Tab") }
            }
            if model.canOperate {
                if let previous = screen.previousHolder(sessionId) {
                    Button("Return to agent") { operate(["op": "controller", "controller": "agent", "threadId": previous.threadId, "agentId": previous.agentId]) }
                }
                Button(state?.mode == "foreground" ? "Use in background" : "Use in foreground") { operate(["op": "mode", "mode": state?.mode == "foreground" ? "background" : "foreground"]) }
                Toggle("Allow secure input", isOn: Binding(get: { state?.secureInputAllowed == true }, set: { operate(["op": "secure.input", "allowed": $0]) }))
                Button("Start recording") { operate(["op": "record.start"]) }
                Button("Stop recording") { operate(["op": "record.stop"]) }
                Button("Stop sharing", role: .destructive) { operate(["op": "stop"]) }
            }
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("App controls").disabled(screen.busy || model.connection != "ready")
    }
    private func operate(_ values: [String: Any]) {
        var operation = values; operation["sessionId"] = sessionId
        Task { _ = await screen.perform(model, operation) }
    }
    private func key(_ key: String) { Task { _ = await screen.input(model, id: sessionId, ["kind": "key.press", "key": key, "modifiers": []]) } }
    private func type() {
        guard !typing, !text.isEmpty else { return }
        let input = text; typing = true
        Task { if await screen.input(model, id: sessionId, ["kind": "text.type", "text": input]), text == input { text = "" }; typing = false }
    }
    private func gesture(_ start: CGPoint, _ end: CGPoint) {
        var input: [String: Any] = ["kind": "pointer.click", "x": start.x, "y": start.y]
        if hypot(end.x - start.x, end.y - start.y) > AceTheme.Spacing.sm {
            if drag { input = ["kind": "pointer.drag", "x": start.x, "y": start.y, "toX": end.x, "toY": end.y, "durationMs": 350] }
            else { input = ["kind": "scroll", "x": start.x, "y": start.y, "dx": max(-1000, min(1000, Int(start.x - end.x))), "dy": max(-1000, min(1000, Int(start.y - end.y)))] }
        }
        Task { _ = await screen.input(model, id: sessionId, input) }
    }
}

private struct MacScreenSurface: UIViewRepresentable {
    let live: ScreenLiveModel
    let interactive: Bool
    let input: (CGPoint, CGPoint) -> Void
    func makeUIView(context: Context) -> DeviceSurfaceView {
        let view = DeviceSurfaceView(); view.accessibilityLabel = "Mac app window"; view.accessibilityIdentifier = "screen.surface"
        return view
    }
    func updateUIView(_ view: DeviceSurfaceView, context: Context) { view.nextPicture = { live.nextPicture() }; view.interactive = interactive; view.onGesture = input }
}
