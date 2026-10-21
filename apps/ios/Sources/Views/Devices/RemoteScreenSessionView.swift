import SwiftUI

/// One Mac app, live, in the device screen's pattern: the window fitted to the phone, who has
/// it in one sentence with Take over or Hand back, keys and typing in the bottom toolbar, and
/// the session's options in ⋯.
struct RemoteScreenSessionView: View {
    let model: ClientModel
    let screen: RemoteScreen
    let sessionId: String
    @Environment(\.scenePhase) private var scene
    @State private var text = ""
    @State private var typing = false
    @State private var drag = false
    @State private var stopping = false
    /// The window's size in points, once its first picture arrives, so the view hugs it.
    @State private var windowSize: CGSize?
    private var state: RemoteScreenState? { screen.state(sessionId) }
    private var session: ScreenSessionInfo? { screen.session(sessionId) }
    private var controlling: Bool { model.connection == "ready" && model.canOperate && screen.controls(sessionId) }

    var body: some View {
        ZStack {
            AceTheme.Colours.background.ignoresSafeArea()
            if state?.lifecycle == "live" {
                DeviceSurface(next: { screen.live.nextPicture() }, interactive: controlling, label: "\(session?.app ?? "Mac app") window",
                              identifier: "screen.surface", screenSize: { windowSize = $0 }) { from, to in gesture(from.point, to.point) }
                    .aspectRatio(windowSize ?? CGSize(width: 4, height: 3), contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: AceTheme.Radii.card, style: .continuous))
                    .padding(AceTheme.Spacing.lg)
            } else {
                Text(session?.error.isEmpty == false ? session?.error ?? "" : session?.status ?? "The app isn't live.")
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).multilineTextAlignment(.center)
                    .padding(AceTheme.Spacing.xl)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { strip }
        .threadTitle(session?.app ?? "Mac app", subtitle: session.map { [$0.mode, $0.capturing ? "Capturing" : ""].filter { !$0.isEmpty }.joined(separator: " · ") } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task(id: "\(scene)-\(model.connection)") {
            guard scene == .active, model.connection == "ready" else { screen.unwatch(model, id: sessionId); return }
            await screen.refresh(model); await screen.watch(model, id: sessionId)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await screen.refresh(model)
            }
        }
        .onDisappear { screen.unwatch(model, id: sessionId) }
        .confirmationDialog("Stop sharing \(session?.app ?? "this app")?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop sharing", role: .destructive) { operate(["op": "stop"]) }
        } message: { Text("Agents using it lose it, and its live view ends.") }
    }

    /// "Claude is in control · Take over", "You're in control · Hand back", and typing.
    @ViewBuilder private var strip: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            if typing, controlling {
                HStack(spacing: AceTheme.Spacing.sm) {
                    TextField("Type in the app", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.send).onSubmit(type)
                    Button("Send", action: type).disabled(text.isEmpty)
                }
                .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceTheme.Dimensions.touchTarget)
                .aceGlass(in: Capsule())
                .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.xs)
            }
            if let problem = screen.problem {
                Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, AceTheme.Spacing.xl)
            }
            if let session, session.lifecycle == "live" {
                HStack(spacing: AceTheme.Spacing.md) {
                    Text(session.status).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if model.canOperate {
                        Button(actionTitle) { Task { await control() } }
                            .buttonStyle(.borderless)
                            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .foregroundStyle(AceTheme.Colours.foreground).fontWeight(.semibold)
                            .disabled(screen.busy)
                            .accessibilityIdentifier("screen.control")
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.xl).frame(minHeight: AceTheme.Dimensions.touchTarget)
            }
        }
    }
    private var actionTitle: String {
        guard controlling else { return "Take over" }
        return screen.previousHolder(sessionId) == nil ? "Release" : "Hand back"
    }
    /// The one control the person has: take it from whoever has it, or give it back.
    private func control() async {
        guard controlling else { await screen.takeControl(model, id: sessionId); return }
        if let previous = screen.previousHolder(sessionId) {
            await operate(["op": "controller", "controller": "agent", "threadId": previous.threadId, "agentId": previous.agentId])
        } else {
            await screen.release(model, id: sessionId)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            Menu {
                Button("Return") { key("Return") }
                Button("Escape") { key("Escape") }
                Button("Tab") { key("Tab") }
            } label: { Label("Keys", systemImage: "command") }
            .disabled(!controlling)
            Spacer()
            Button("Type", systemImage: "keyboard") { typing.toggle() }.disabled(!controlling)
            Menu {
                Toggle("Drag instead of scroll", isOn: $drag).disabled(!controlling)
                if model.canOperate, let state {
                    Button(state.mode == "foreground" ? "Back to background" : "Bring to front", systemImage: "macwindow.on.rectangle") {
                        operate(["op": "mode", "mode": state.mode == "foreground" ? "background" : "foreground"])
                    }
                    Toggle("Allow typing in secure fields", isOn: Binding(get: { state.secureInputAllowed == true }, set: { operate(["op": "secure.input", "allowed": $0]) }))
                    Button("Start recording", systemImage: "record.circle") { operate(["op": "record.start"]) }
                    Button("Stop recording", systemImage: "stop.circle") { operate(["op": "record.stop"]) }
                    if session?.stoppable == true {
                        Button("Stop sharing…", systemImage: "stop", role: .destructive) { stopping = true }
                    }
                }
            } label: { Label("App options", systemImage: "ellipsis") }
            .disabled(screen.busy || model.connection != "ready")
        }
    }

    private func operate(_ values: [String: Any]) {
        Task { await operate(values) }
    }
    private func operate(_ values: [String: Any]) async {
        var operation = values; operation["sessionId"] = sessionId
        _ = await screen.perform(model, operation)
    }
    private func key(_ key: String) { Task { _ = await screen.input(model, id: sessionId, ["kind": "key.press", "key": key, "modifiers": []]) } }
    private func type() {
        guard !text.isEmpty else { return }
        let input = text; text = ""
        Task { _ = await screen.input(model, id: sessionId, ["kind": "text.type", "text": input]) }
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
