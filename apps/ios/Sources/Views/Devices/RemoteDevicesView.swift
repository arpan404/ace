import SwiftUI

struct RemoteDevicesView: View {
    let model: ClientModel
    @State private var devices = RemoteDevices()
    var body: some View {
        List {
            Section {
                Toggle("Devices", isOn: Binding(get: { devices.enabled }, set: { enabled in
                    Task { _ = await devices.perform(model, operation: ["op": "enable", "enabled": enabled]) }
                })).disabled(!model.canOperate || devices.busy || !devices.loaded)
            }
            ForEach(devices.devices) { device in
                NavigationLink { RemoteDeviceView(model: model, devices: devices, device: device) } label: {
                    HStack(spacing: AceTheme.Spacing.md) {
                        Image(systemName: device.platform == "ios" ? "iphone" : "smartphone").foregroundStyle(AceTheme.Colours.decoration)
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                            Text(device.name)
                            Text([device.runtime, device.state.capitalized].compactMap { $0 }.joined(separator: " · "))
                                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                    }.padding(.vertical, AceTheme.Spacing.xs)
                }
            }
            ForEach(Array(devices.issues.enumerated()), id: \.offset) { _, issue in
                Label([issue.message, issue.hint].compactMap { $0 }.joined(separator: " "), systemImage: "info.circle")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityIdentifier("devices.setup")
            }
            ServiceProblem(message: devices.problem)
            if devices.problem != nil { Button("Retry") { Task { await devices.refresh(model) } } }
            if !devices.loaded && devices.problem == nil { ProgressView().accessibilityLabel("Loading devices") }
            if devices.loaded && devices.devices.isEmpty { ContentUnavailableView("No simulators or emulators", systemImage: "iphone", description: Text("Create one in Xcode or Android Studio on your machine.")) }
        }
        .navigationTitle("Simulators and devices").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await devices.refresh(model) } }
        .refreshable { await devices.refresh(model) }
    }
}

private struct RemoteDeviceView: View {
    let model: ClientModel
    @Bindable var devices: RemoteDevices
    let device: RemoteDevice
    @Environment(\.scenePhase) private var scene
    @State private var text = ""
    @State private var typing = false
    @State private var appId = ""
    @State private var url = ""
    @State private var showingActions = false
    private var state: RemoteDeviceState? { devices.state(device.id) }
    private var active: Bool { state?.lifecycle == "live" }
    private var controlling: Bool { state?.controller == "human" && state?.ownedHere == true && model.canOperate }
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            if active {
                DeviceSurface(live: devices.live, interactive: controlling, input: gesture)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView {
                    Label(device.name, systemImage: "iphone")
                } description: { Text(state?.error?.message ?? device.state.capitalized) } actions: {
                    if model.canOperate {
                        Button(device.state == "shutdown" ? "Boot and view" : "Start viewing") { Task { await start() } }
                            .buttonStyle(.borderedProminent).disabled(devices.busy || !devices.enabled)
                    }
                }
            }
            if let problem = devices.problem { ServiceProblem(message: problem).padding(AceTheme.Spacing.md) }
            if active {
                HStack(spacing: AceTheme.Spacing.sm) {
                    if model.canOperate {
                        Button(controlling ? "Release control" : "Take control") {
                            Task { _ = await devices.perform(model, operation: ["op": "controller", "deviceId": device.id, "controller": controlling ? "none" : "human"]) }
                        }.disabled(devices.busy)
                    }
                    Spacer()
                    if controlling {
                        Button { key(device.platform == "ios" ? "home" : "back") } label: { Image(systemName: device.platform == "ios" ? "house" : "chevron.backward") }.accessibilityLabel(device.platform == "ios" ? "Home" : "Back")
                        Button { key("rotate") } label: { Image(systemName: "rotate.right") }.accessibilityLabel("Rotate device")
                    }
                    Button { showingActions = true } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Device actions")
                }
                .frame(minHeight: AceTheme.Dimensions.touchTarget).padding(.horizontal, AceTheme.Spacing.lg)
                if controlling {
                    HStack {
                        TextField("Type on device", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().onSubmit(type)
                        Button("Send", action: type).disabled(text.isEmpty || typing)
                    }.frame(minHeight: AceTheme.Dimensions.touchTarget).padding(.horizontal, AceTheme.Spacing.lg)
                }
            }
        }
        .background(AceTheme.Colours.background)
        .navigationTitle(device.name).navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingActions) { actions }
        .task(id: "\(scene)-\(model.connection)") {
            guard scene == .active, model.connection == "ready" else { await devices.unwatch(model, deviceId: device.id); return }
            await devices.refresh(model)
            if active { await devices.watch(model, deviceId: device.id) }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await devices.refresh(model)
            }
        }
        .onDisappear { devices.live.close(); Task { await devices.unwatch(model, deviceId: device.id) } }
    }
    private func start() async {
        if device.state == "shutdown", !(await devices.perform(model, operation: ["op": "boot", "deviceId": device.id])) { return }
        if await devices.perform(model, operation: ["op": "start", "deviceId": device.id, "fps": 60]) { await devices.watch(model, deviceId: device.id) }
    }
    private func gesture(_ from: CGPoint, _ to: CGPoint) {
        let x = max(0, Int(from.x.rounded())), y = max(0, Int(from.y.rounded()))
        var input: [String: Any] = ["kind": "tap", "x": x, "y": y]
        if hypot(to.x - from.x, to.y - from.y) > AceTheme.Spacing.sm {
            input = ["kind": "swipe", "x": x, "y": y, "toX": max(0, Int(to.x.rounded())), "toY": max(0, Int(to.y.rounded())), "durationMs": 350]
        }
        Task { _ = await devices.input(model, deviceId: device.id, input) }
    }
    private func key(_ key: String) { Task { _ = await devices.input(model, deviceId: device.id, ["kind": "key", "key": key]) } }
    private func type() {
        guard !typing, !text.isEmpty else { return }
        let input = text; typing = true
        Task {
            if await devices.input(model, deviceId: device.id, ["kind": "type", "text": input]), text == input { text = "" }
            typing = false
        }
    }
    private var actions: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("App bundle ID", text: $appId).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Open app") { operate(["op": "open_app", "appId": appId]) }.disabled(appId.isEmpty)
                    TextField("URL", text: $url).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Open URL") { operate(["op": "open_url", "url": url]) }.disabled(url.isEmpty)
                }
                Section {
                    Button(state?.recording == true ? "Stop recording" : "Record device") { operate(["op": state?.recording == true ? "record.stop" : "record.start"]) }
                    Button("Light appearance") { operate(["op": "configure", "settings": ["appearance": "light"]]) }
                    Button("Dark appearance") { operate(["op": "configure", "settings": ["appearance": "dark"]]) }
                    Button("Stop viewing") { operate(["op": "stop"]); showingActions = false }
                }
            }
            .disabled(!model.canOperate || devices.busy)
            .navigationTitle("Device actions").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingActions = false } } }
        }
        .presentationDetents([.medium, .large])
    }
    private func operate(_ values: [String: Any]) { var operation = values; operation["deviceId"] = device.id; Task { _ = await devices.perform(model, operation: operation) } }
}
