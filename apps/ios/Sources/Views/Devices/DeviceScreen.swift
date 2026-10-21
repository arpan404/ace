import SwiftUI

/// What a device screen opens over itself.
enum DeviceSheet: Identifiable {
    case logs, tree, action(DeviceAction), screenshot(UIImage)
    var id: String {
        switch self {
        case .logs: "logs"
        case .tree: "tree"
        case .action(let action): action.rawValue
        case .screenshot: "screenshot"
        }
    }
}

/// One simulator or emulator, live: its screen in its frame, touches mapped to the device, who
/// controls it in one sentence, the hardware a phone can press in the bottom toolbar, and logs,
/// UI tree and actions in ⋯. The agent's newest action floats over the screen for a moment.
struct DeviceScreen: View {
    @Bindable var model: ClientModel
    let threadId: String?
    let deviceId: String
    let name: String
    /// Opened on its own (from a transcript step): leaving closes the Devices view too.
    var closesView = false
    @Environment(\.scenePhase) private var scene
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var typing = false
    @State private var text = ""
    @State private var sheet: DeviceSheet?
    @State private var confirmShutdown = false
    @State private var screenSize: CGSize?
    @State private var caption: DeviceScreenInfo.Activity?
    @State private var seen: Int?
    @State private var autoStarted = false
    @State private var handle = DeviceSurfaceHandle()
    @FocusState private var fieldFocused: Bool
    private var devices: DevicesModel { model.devices }
    private var info: DeviceScreenInfo? { devices.view?.device.flatMap { $0.id == deviceId ? $0 : nil } }
    private var canDrive: Bool { model.canOperate && model.connection == "ready" && info?.interactive == true }

    var body: some View {
        stage
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { strip }
            .background(AceTheme.Colours.background)
            .threadTitle(info?.name ?? name, subtitle: info?.subtitle ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .task(id: "\(scene)-\(model.connection)") {
                guard scene == .active, model.connection == "ready" else { devices.unwatchPictures(model, deviceId: deviceId); return }
                devices.watch(model, threadId: threadId, deviceId: deviceId)
            }
            .task(id: info?.live == true && scene == .active) {
                if info?.live == true, scene == .active { await devices.watchPictures(model, deviceId: deviceId) }
            }
            .onChange(of: info?.running == true && info?.live == false && info?.busy == false) { _, idle in autoStart(idle) }
            .onChange(of: info?.activity?.sequence) { _, _ in showActivity() }
            .onAppear { seen = info?.activity?.sequence }
            .onDisappear {
                devices.unwatchPictures(model, deviceId: deviceId)
                if closesView { devices.close(model) } else { devices.watch(model, threadId: threadId, deviceId: nil) }
                if ["release", "handBack"].contains(info?.control.action) { model.action(["type": "native.devices.release", "deviceId": deviceId]) }
            }
            .sheet(item: $sheet) { sheet in sheetView(sheet) }
            .confirmationDialog("Shut down \(info?.name ?? name)?", isPresented: $confirmShutdown, titleVisibility: .visible) {
                Button("Shut down", role: .destructive) { operate(["op": "shutdown"]) }
            } message: {
                Text("Its apps close and its live view stops, for any agent using it too.")
            }
    }

    // MARK: Stage

    private var stage: some View {
        GeometryReader { proxy in
            if let info {
                let size = screenSize ?? CGSize(width: info.screen.width, height: info.screen.height)
                let geometry = size.width > size.height ? info.frame.landscape : info.frame.portrait
                let room = CGSize(width: proxy.size.width - AceTheme.Spacing.xxl * 2, height: proxy.size.height - AceTheme.Spacing.lg * 2)
                DeviceFrameView(geometry: geometry, layout: DeviceFrameLayout(room: room, geometry: geometry, screen: size)) {
                    ZStack {
                        Color.black
                        if info.live {
                            DeviceSurface(next: { devices.live.nextPicture() }, interactive: canDrive, handle: handle,
                                          label: "\(info.name) screen", screenSize: { screenSize = $0 }) { from, to in
                                devices.gesture(model, threadId: threadId, deviceId: deviceId, from: from, to: to)
                            }
                            ripple(size)
                        } else {
                            idle(info)
                        }
                    }
                    .overlay(alignment: .bottom) { activityCaption.padding(.bottom, AceTheme.Spacing.xxl) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityLabel("Loading \(name)")
            }
        }
    }

    /// Over the dark screen when it isn't streaming: what the device is doing, and the next step.
    @ViewBuilder private func idle(_ info: DeviceScreenInfo) -> some View {
        VStack(spacing: AceTheme.Spacing.md) {
            if let problem = info.problem ?? devices.problem, problem.permission != nil {
                Text(problem.message).multilineTextAlignment(.center)
                idleButton("Open settings") { operate(["op": "permissions.request", "permission": problem.permission ?? ""], device: false) }
                idleButton("Try again") { operate(["op": "start", "fps": 60]) }
            } else if info.busy {
                ProgressView().tint(.white)
                Text(info.where)
            } else if info.cleanupRequired {
                Text("The live view didn't stop cleanly.")
                idleButton("Retry cleanup") { operate(["op": "stop"]) }
            } else if info.running {
                Text("The live view is off.")
                idleButton("Start live view") { operate(["op": "start", "fps": 60]) }
            } else {
                Text("\(info.name) is off.")
                idleButton("Boot") { boot() }
            }
        }
        .aceFont(AceTheme.Typography.body, relativeTo: .body)
        .foregroundStyle(Color.white.opacity(0.8))
        .padding(AceTheme.Spacing.lg)
    }
    private func idleButton(_ title: String, run: @escaping () -> Void) -> some View {
        Button(title, action: run).buttonStyle(.borderless)
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).foregroundStyle(.white)
            .disabled(!model.canOperate || devices.busy)
    }

    /// The agent's tap, as a ring where it landed, while its caption shows.
    @ViewBuilder private func ripple(_ size: CGSize) -> some View {
        if let caption, let x = caption.x, let y = caption.y, size.width > 0, size.height > 0 {
            GeometryReader { proxy in
                Circle().strokeBorder(AceTheme.Status.working, lineWidth: 2)
                    .background(Circle().fill(AceTheme.Status.working.opacity(0.2)))
                    .frame(width: 44, height: 44)
                    .position(x: proxy.size.width * min(max(x / size.width, 0), 1), y: proxy.size.height * min(max(y / size.height, 0), 1))
            }
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    @ViewBuilder private var activityCaption: some View {
        if let caption {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                if !caption.provider.isEmpty { ProviderMark(provider: caption.provider, size: 13) }
                Text(caption.caption).lineLimit(1)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
            .aceGlass(in: Capsule())
            .transition(.opacity)
            .accessibilityLabel("Agent action: \(caption.caption)")
            .accessibilityIdentifier("devices.activity")
        }
    }
    /// Each new action shows once, for about two seconds; what was there on opening isn't replayed.
    private func showActivity() {
        guard let activity = info?.activity, activity.sequence != seen else { return }
        seen = activity.sequence
        withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { caption = activity }
        Task {
            try? await Task.sleep(for: .seconds(2))
            if caption?.sequence == activity.sequence {
                withAnimation(reduceMotion ? nil : AceTheme.Motion.exitCurve) { caption = nil }
            }
        }
    }

    // MARK: Control and input

    /// "Claude is using iPhone 17 Pro · Take over", "You're in control · Hand back", and the
    /// keyboard field while it is open.
    @ViewBuilder private var strip: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            if typing, canDrive {
                HStack(spacing: AceTheme.Spacing.sm) {
                    TextField("Type on the device", text: $text)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($fieldFocused).submitLabel(.send).onSubmit(type)
                    Button("Send", action: type).disabled(text.isEmpty)
                }
                .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceTheme.Dimensions.touchTarget)
                .aceGlass(in: Capsule())
                .padding(.horizontal, AceTheme.Spacing.md).padding(.bottom, AceTheme.Spacing.xs)
                .accessibilityIdentifier("devices.keyboard")
            }
            // What went wrong with the last request, in the device's words, until the next one.
            if let problem = devices.problem, problem.permission == nil || info?.live == true {
                Text(problem.text)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.xs)
                    .accessibilityIdentifier("devices.problem")
            }
            if let info, !info.control.sentence.isEmpty {
                HStack(spacing: AceTheme.Spacing.md) {
                    Text(info.control.sentence)
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if model.canOperate, let title = controlTitle(info.control.action) {
                        Button(title) { Task { await control(info.control) } }
                            .buttonStyle(.borderless)
                            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .foregroundStyle(AceTheme.Colours.foreground).fontWeight(.semibold)
                            .disabled(devices.busy || model.connection != "ready")
                            .accessibilityIdentifier("devices.control")
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.xl).frame(minHeight: AceTheme.Dimensions.touchTarget)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("devices.strip")
            }
        }
    }
    private func controlTitle(_ action: String) -> String? {
        switch action {
        case "take": "Take over"
        case "handBack": "Hand back"
        case "release": "Release"
        default: nil
        }
    }
    private func control(_ control: DeviceScreenInfo.Control) async {
        switch control.action {
        case "take": await devices.perform(model, threadId: threadId, ["op": "controller", "deviceId": deviceId, "controller": "human"])
        case "handBack":
            guard let holder = control.holder else { return }
            await devices.perform(model, threadId: threadId, ["op": "controller", "deviceId": deviceId, "controller": "agent",
                                                               "threadId": holder.threadId, "agentId": holder.agentId])
        default: await devices.perform(model, threadId: threadId, ["op": "controller", "deviceId": deviceId, "controller": "none"])
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .bottomBar) {
            Button("Home", systemImage: "house") { key("home") }.disabled(!canDrive).accessibilityIdentifier("devices.home")
            if info?.platform == "android" {
                Button("Back", systemImage: "arrow.uturn.backward") { key("back") }.disabled(!canDrive)
            }
            if let buttons = info?.buttons, !buttons.isEmpty {
                Menu {
                    ForEach(buttons) { button in Button(button.label) { key(button.key) } }
                } label: { Label("Side buttons", systemImage: "button.vertical.right.press") }
                .disabled(!canDrive)
            }
            Spacer()
            Button("Type", systemImage: "keyboard") {
                typing.toggle()
                fieldFocused = typing
            }
            .disabled(!canDrive).accessibilityIdentifier("devices.type")
            DeviceMenu(info: info, canOperate: model.canOperate && model.connection == "ready", canDrive: canDrive, busy: devices.busy,
                       open: { sheet = $0 }, key: key, operate: { operate($0) }, boot: boot,
                       screenshot: { if let image = handle.snapshot() { sheet = .screenshot(image) } },
                       shutdown: { confirmShutdown = true })
        }
    }

    private func key(_ key: String) { operate(["op": "input", "input": ["kind": "key", "key": key]]) }
    private func type() {
        guard !text.isEmpty else { return }
        let typed = text
        text = ""
        operate(["op": "input", "input": ["kind": "type", "text": typed]])
    }
    private func boot() {
        Task {
            autoStarted = true
            if await devices.perform(model, threadId: threadId, ["op": "boot", "deviceId": deviceId]) {
                await devices.perform(model, threadId: threadId, ["op": "start", "deviceId": deviceId, "fps": 60])
            }
        }
    }
    /// A running device shows its screen as soon as it opens: start the live view once.
    private func autoStart(_ idle: Bool) {
        guard idle, !autoStarted, model.connection == "ready", info?.cleanupRequired == false, info?.problem == nil else { return }
        autoStarted = true
        operate(["op": "start", "fps": 60])
    }
    private func operate(_ values: [String: Any], device: Bool = true) {
        var operation = values
        if device { operation["deviceId"] = deviceId }
        Task { await devices.perform(model, threadId: threadId, operation) }
    }

    @ViewBuilder private func sheetView(_ sheet: DeviceSheet) -> some View {
        switch sheet {
        case .logs: DeviceLogsSheet(model: model, deviceId: deviceId)
        case .tree: DeviceTreeSheet(model: model, deviceId: deviceId, live: info?.live == true)
        case .action(let action):
            DeviceActionSheet(action: action) { values in operate(values) }
        case .screenshot(let image): DeviceScreenshotSheet(image: image, name: info?.name ?? name)
        }
    }
}
