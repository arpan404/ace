import SwiftUI

/// The simulators and emulators on a thread's machine (`bridge/devices-view.ts`): running ones
/// first with who controls each, Start a device for the rest, and setup problems as one sentence
/// each. A device opens its live screen. `threadId` is nil from Settings › Tools.
struct DevicesScreen: View {
    @Bindable var model: ClientModel
    let threadId: String?
    @State private var opened: DeviceTile?
    @State private var starting = false
    @State private var disabling = false
    private var devices: DevicesModel { model.devices }
    private var view: DevicesView? { devices.view }

    var body: some View {
        List {
            if model.connection != "ready" {
                InboxConnectionBanner(connection: model.connection, retry: model.retry).listRowSeparator(.hidden)
            }
            content
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .threadTitle("Devices", subtitle: subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { menu }
            if view?.enabled == true, model.canOperate {
                ToolbarItem(placement: .bottomBar) {
                    Button("Start a device") { starting = true }.accessibilityIdentifier("devices.start")
                }
            }
        }
        .refreshable { await refresh() }
        .task(id: model.connection) {
            if model.connection == "ready" { devices.watch(model, threadId: threadId, deviceId: nil) }
        }
        .onDisappear { if opened == nil { devices.close(model) } }
        .navigationDestination(item: $opened) { tile in
            DeviceScreen(model: model, threadId: threadId, deviceId: tile.id, name: tile.name)
        }
        .sheet(isPresented: $starting) {
            DeviceCatalogSheet(model: model, threadId: threadId) { tile in
                starting = false
                opened = tile
            }
        }
        .confirmationDialog("Turn off devices on this machine?", isPresented: $disabling, titleVisibility: .visible) {
            Button("Turn off devices", role: .destructive) {
                Task { await devices.perform(model, threadId: threadId, ["op": "enable", "enabled": false]) }
            }
        } message: {
            Text("This turns devices off for every thread, not just this one. Agents lose the devices they are using, and live views stop.")
        }
    }

    private var subtitle: String {
        guard let view, view.connected, view.enabled else { return "" }
        return view.running.isEmpty ? "None running" : "\(view.running.count) running"
    }

    @ViewBuilder private var content: some View {
        if let view {
            if let offline = view.offline {
                DeviceNote(sentence: offline.text, action: "Reconnect") { reconnect() }
            } else if !view.connected || view.loading {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden).accessibilityLabel("Loading devices")
            } else if !view.enabled {
                DeviceNote(sentence: "Devices are off on this machine.", action: model.canOperate ? "Turn on" : nil) {
                    Task { await turnOn() }
                }
            } else {
                running(view)
            }
            if let problem = devices.problem { DeviceNote(sentence: problem.text, action: nil) {} }
        } else {
            ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden).accessibilityLabel("Loading devices")
        }
    }

    @ViewBuilder private func running(_ view: DevicesView) -> some View {
        if view.running.isEmpty {
            Text("No devices running.")
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .listRowSeparator(.hidden)
        }
        ForEach(view.running) { tile in
            Button { opened = tile } label: { DeviceRow(tile: tile) }
                .buttonStyle(.plain)
                .listRowBackground(AceTheme.Colours.background)
                .listRowSeparatorTint(AceTheme.Colours.separator)
                .accessibilityIdentifier("devices.row")
        }
        ForEach(Array(view.notes.enumerated()), id: \.offset) { _, note in
            DeviceNote(sentence: note.text, action: view.toolsMissing && model.canOperate ? "Download device tools" : nil) {
                Task {
                    if await devices.perform(model, threadId: threadId, ["op": "tools.install"]) { await refresh() }
                }
            }
        }
    }

    private var menu: some View {
        Menu {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
            if model.canOperate, view?.enabled == true {
                Button("Turn off devices…", systemImage: "nosign", role: .destructive) { disabling = true }
            }
        } label: { Label("Devices options", systemImage: "ellipsis") }
        .accessibilityIdentifier("devices.menu")
    }

    private func refresh() async { await devices.refresh(model) }
    private func reconnect() {
        model.action(["type": "native.devices.close"])
        devices.watch(model, threadId: threadId, deviceId: nil)
    }
    /// Turning devices on also downloads the tools ace runs, as on the web.
    private func turnOn() async {
        guard await devices.perform(model, threadId: threadId, ["op": "enable", "enabled": true]) else { return }
        await refresh()
        if view?.toolsMissing == true { _ = await devices.perform(model, threadId: threadId, ["op": "tools.install"]) }
    }
}

/// Where a thread's Devices entry goes: the list, or one device straight from its transcript step.
enum DevicesRoute: Hashable, Identifiable {
    case list
    case device(String)
    var id: String {
        switch self {
        case .list: "list"
        case .device(let id): id
        }
    }
}
struct DevicesRouteView: View {
    @Bindable var model: ClientModel
    let threadId: String
    let route: DevicesRoute
    var body: some View {
        switch route {
        case .list: DevicesScreen(model: model, threadId: threadId)
        case .device(let id): DeviceScreen(model: model, threadId: threadId, deviceId: id, name: "Device", closesView: true)
        }
    }
}

/// A device's symbol for its kind.
enum DeviceSymbol {
    static func of(_ kind: String) -> String {
        switch kind {
        case "ipad", "android-tablet": "ipad"
        case "watch": "applewatch"
        case "tv": "appletv"
        case "vision": "visionpro"
        case "android-phone": "smartphone"
        default: "iphone"
        }
    }
}

/// One device: its kind, name, "iOS 26.0 · Live" and who is using it.
struct DeviceRow: View {
    let tile: DeviceTile
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: DeviceSymbol.of(tile.kind)).font(.system(size: 21))
                .foregroundStyle(AceTheme.Colours.foreground).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(tile.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text([tile.detail, tile.control].filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                .foregroundStyle(AceTheme.Colours.decoration).accessibilityHidden(true)
        }
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A setup problem or state as one plain sentence, with one text action.
struct DeviceNote: View {
    let sentence: String
    let action: String?
    let run: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(sentence).aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            if let action {
                Button(action, action: run).buttonStyle(.borderless)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground)
            }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("devices.note")
    }
}
