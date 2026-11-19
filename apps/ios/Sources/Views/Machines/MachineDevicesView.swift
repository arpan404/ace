import SwiftUI

/// One machine's paired phones, tablets and browsers, and its pairing links nobody has used yet,
/// as the web's Fleet › Devices: pair another device with a chosen access and lifetime, cancel a
/// link shared by mistake, revoke a device. The same grouped list as the machine's page, each
/// device's Revoke in its row's ⋯ menu and on a swipe. Needs administrator access on that machine.
struct MachineDevicesView: View {
    let model: ClientModel
    let machine: String
    @State private var overview: FleetOverview?
    @State private var problem: String?
    @State private var pairing = false
    @State private var revoking: FleetOverview.Device?
    @State private var revokingOthers = false
    @State private var notice: String?
    @State private var retryRequest: [String: Any]?
    @State private var busy = false
    @State private var changes = 0

    var body: some View {
        List {
            if let problem {
                ProblemRow(problem, id: "devices.problem") { model.retry(); Task { await read() } }
            }
            if let overview {
                if overview.forbidden {
                    ProblemRow(overview.devicesProblem ?? "Only a phone paired with full access can manage devices.", id: "devices.problem")
                } else {
                    devices(overview)
                    links(overview)
                    if model.canOperate, overview.devices.contains(where: { !$0.`self` }) {
                        Section {
                            Button("Revoke all other devices…", role: .destructive) { revokingOthers = true }
                                .buttonStyle(.rowAction)
                                .accessibilityIdentifier("devices.revokeOthers")
                        }
                        .insetRowBackground()
                    }
                }
            } else if problem == nil {
                Section { SkeletonRows(count: 2, label: "Reading this machine's devices").listRowInsets(EdgeInsets()) }
                    .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(overview == nil)
        .smoothChange(overview.map { $0.devices.map(\.id) + $0.pairings.map(\.id) })
        .sensoryFeedback(.success, trigger: changes)
        .disabled(busy)
        .navigationTitle("Devices").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if overview?.forbidden == false, model.canOperate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Pair a device") { pairing = true }.accessibilityIdentifier("devices.pair")
                }
            }
        }
        .task(id: model.connection) { await read() }
        .refreshable { await read() }
        .sheet(isPresented: $pairing, onDismiss: { Task { await read() } }) {
            if let choices = overview?.choices {
                NavigationStack { PairDeviceView(model: model, machine: machine, choices: choices) { pairing = false } }
                    .tint(AceDesign.Ink.action)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
        }
        .confirmationDialog("Revoke \(revoking?.name ?? "this device")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { device in
            Button("Revoke", role: .destructive) { Task { await run(["op": "revoke", "deviceId": device.id]) } }
                .accessibilityIdentifier("devices.revoke.confirm")
        } message: { device in
            Text("\(device.`self` ? "This iPhone" : "This device") will disconnect from \(machine). Pair it again to restore access.")
        }
        .confirmationDialog("Revoke every other device?", isPresented: $revokingOthers, titleVisibility: .visible) {
            Button("Revoke all others", role: .destructive) { Task { await run(["op": "revokeOthers"]) } }
        } message: { Text("Every device paired with \(machine) except this iPhone will disconnect. Pair them again to restore access.") }
        .alert("Couldn't do that", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            if let retryRequest { Button("Try again") { Task { await run(retryRequest) } } }
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
    }

    @ViewBuilder private func devices(_ overview: FleetOverview) -> some View {
        if let problem = overview.devicesProblem {
            ProblemRow(problem, id: "devices.list.problem") { Task { await read() } }
        }
        Section {
            if overview.devices.isEmpty, overview.devicesProblem == nil {
                Text("No paired devices.").foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(overview.devices) { device in
                RowWithActions(title: device.name, detail: line(device), actionsLabel: "Actions for \(device.name)",
                               actionsId: "devices.actions.\(device.id)", canOperate: model.canOperate) {
                    Button("Revoke…", systemImage: "xmark.circle", role: .destructive) { revoking = device }
                        .accessibilityIdentifier("devices.revoke.\(device.id)")
                }
            }
        } header: { InsetHeader("Paired with \(machine)") } footer: {
            Text("Phones, tablets and browsers that follow and steer agents. They run none themselves.")
        }
        .insetRowBackground()
    }

    @ViewBuilder private func links(_ overview: FleetOverview) -> some View {
        let open = overview.pairings.filter { Date(timeIntervalSince1970: $0.expiresAt / 1000) > Date() }
        if let problem = overview.pairingsProblem {
            ProblemRow(problem, id: "devices.links.problem") { Task { await read() } }
        }
        if !open.isEmpty {
            Section {
                ForEach(open) { pairing in
                    let until = Date(timeIntervalSince1970: pairing.expiresAt / 1000).formatted(date: .omitted, time: .shortened)
                    RowWithActions(title: pairing.label, detail: "\(pairing.line) · works until \(until)",
                                   actionsLabel: "Actions for \(pairing.label)", actionsId: "devices.link.\(pairing.id)",
                                   canOperate: model.canOperate) {
                        Button("Cancel link", systemImage: "xmark.circle", role: .destructive) {
                            Task { await run(["op": "cancelPairing", "id": pairing.id]) }
                        }
                        .accessibilityIdentifier("devices.cancel.\(pairing.id)")
                    }
                }
            } header: { InsetHeader("Open pairing links") } footer: { Text("Each works once. Cancel one you shared by mistake.") }
            .insetRowBackground()
        }
    }

    private func line(_ device: FleetOverview.Device) -> String {
        var parts: [String] = []
        if device.`self` { parts.append("This phone") }
        parts.append(device.access)
        parts.append("Seen \(Date(timeIntervalSince1970: device.lastSeenAt / 1000).formatted(.relative(presentation: .named)))")
        if let expires = device.expiresAt {
            let date = Date(timeIntervalSince1970: expires / 1000)
            parts.append(date <= Date() ? "Expired" : "Access ends \(date.formatted(.relative(presentation: .named)))")
        }
        return parts.joined(separator: " · ")
    }
    private func read() async {
        guard model.connection == "ready" else { problem = "Can’t reach \(machine)."; return }
        do { overview = try await model.fleetOverview(machine: machine); problem = nil }
        catch { problem = error.localizedDescription }
    }
    private func run(_ request: [String: Any]) async {
        busy = true
        defer { busy = false }
        let answer = await model.fleet(request, machine: machine)
        if answer.ok { changes += 1; retryRequest = nil } else { retryRequest = request; notice = answer.message ?? "Couldn’t complete the request. Try again." }
        await read()
    }
}

