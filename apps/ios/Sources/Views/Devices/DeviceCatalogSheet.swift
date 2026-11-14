import SwiftUI

/// Start a device: every simulator and emulator that's off, by kind, searched and filtered by
/// the bridge with the web's rules. Choosing one boots it and opens its screen.
struct DeviceCatalogSheet: View {
    @Bindable var model: ClientModel
    let threadId: String?
    let chosen: (DeviceTile) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var platform = "all"
    @State private var booting: String?
    private var devices: DevicesModel { model.devices }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Platform", selection: $platform) {
                        Text("All").tag("all")
                        Text("iOS").tag("ios")
                        Text("Android").tag("android")
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: AceDesign.Space.related, leading: AceDesign.Space.margin,
                                              bottom: AceDesign.Space.related, trailing: AceDesign.Space.margin))
                }
                ForEach(devices.view?.groups ?? []) { group in
                    Section { ForEach(group.rows) { tile in row(tile) } } header: { InsetHeader(group.label).listRowInsets(EdgeInsets(top: AceDesign.Space.group, leading: AceDesign.Space.margin, bottom: AceDesign.Space.tight, trailing: AceDesign.Space.margin)) }
                    .listSectionSeparator(.hidden)
                }
                if devices.view?.groups.isEmpty == true {
                    Text(query.isEmpty && platform == "all" ? "Every device is running." : "No devices match.")
                        .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if let problem = devices.problem {
                    Text(problem.text).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                        .foregroundStyle(AceDesign.Ink.muted).listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
            }
            // Cardless: kinds under quiet headings, devices split by hairlines, on the sheet's surface, as Work.
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search devices")
            .navigationTitle("Start a device").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", ace: .x) { dismiss() }.accessibilityIdentifier("devices.catalog.close")
                }
            }
            .onChange(of: query) { search() }
            .onChange(of: platform) { search() }
            .onDisappear { if !query.isEmpty || platform != "all" { devices.watch(model, threadId: threadId, deviceId: nil) } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ tile: DeviceTile) -> some View {
        Button { Task { await start(tile) } } label: {
            // One that can't boot (offline, not authorized, already booting) says what it needs instead.
            InsetRow(icon: DeviceIcon.of(tile.kind), title: tile.name, subtitle: tile.hint ?? tile.detail) {
                if booting == tile.id { WorkingMark(label: "Booting") }
            }
            .frame(minHeight: AceDesign.Size.rowLine)
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(AceTheme.Colours.separator)
        .disabled(booting != nil || !model.canOperate || tile.bootable == false)
        .accessibilityIdentifier("devices.catalog.row")
    }

    private func search() { devices.watch(model, threadId: threadId, deviceId: nil, query: query, platform: platform) }

    /// Boot, then show its screen: booting is how a person asks to see the device.
    private func start(_ tile: DeviceTile) async {
        booting = tile.id
        defer { booting = nil }
        guard await devices.perform(model, threadId: threadId, ["op": "boot", "deviceId": tile.id]) else { return }
        await devices.perform(model, threadId: threadId, ["op": "start", "deviceId": tile.id, "fps": 60])
        chosen(tile)
    }
}
