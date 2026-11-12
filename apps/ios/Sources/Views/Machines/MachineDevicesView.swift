import CoreImage.CIFilterBuiltins
import SwiftUI

/// One machine's paired phones, tablets and browsers, and its pairing links nobody has used yet,
/// as the web's Fleet › Devices: pair another device with a chosen access and lifetime, cancel a
/// link shared by mistake, revoke a device. Needs administrator access on that machine.
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
        QuietPage {
            if let overview {
                if overview.forbidden {
                    QuietGroup { ServiceProblem(message: overview.devicesProblem) }
                } else {
                    devices(overview)
                    links(overview)
                }
            }
            if let problem {
                QuietGroup {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }
                }

            } else if overview == nil {
                QuietGroup { SkeletonRows(count: 2, label: "Reading this machine's devices").listRowInsets(EdgeInsets()) }

            }
        }

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
                    .tint(AceDesign.Ink.accent)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
        }
        .confirmationDialog("Revoke \(revoking?.name ?? "this device")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible, presenting: revoking) { device in
            Button("Revoke", role: .destructive) { Task { await run(["op": "revoke", "deviceId": device.id]) } }
                .accessibilityIdentifier("devices.revoke.confirm")
        } message: { device in
            Text(device.`self` ? "This is this phone. It disconnects from \(machine) at once and has to be paired again." : "It disconnects from \(machine) at once and has to be paired again to see or control threads.")
        }
        .confirmationDialog("Revoke every other device?", isPresented: $revokingOthers, titleVisibility: .visible) {
            Button("Revoke all others", role: .destructive) { Task { await run(["op": "revokeOthers"]) } }
        } message: { Text("Every device paired with \(machine) except this phone disconnects and has to be paired again.") }
        .alert("Couldn't do that", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            if let retryRequest { Button("Retry") { Task { await run(retryRequest) } } }
            Button("OK") { notice = nil }
        } message: { Text(notice ?? "") }
    }

    @ViewBuilder private func devices(_ overview: FleetOverview) -> some View {
        QuietGroup {
            if overview.devices.isEmpty, overview.devicesProblem == nil {
                Text("No paired devices.").foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(overview.devices) { device in
                HStack(alignment: .center, spacing: AceDesign.Space.related) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(device.name).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                        Text(line(device)).font(AceDesign.Typeface.meta)
                            .foregroundStyle(AceDesign.Ink.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: AceDesign.Space.related)
                    if model.canOperate {
                        Button("Revoke", role: .destructive) { revoking = device }
                            .buttonStyle(.textAction(.destructive))
                            .accessibilityIdentifier("devices.revoke.\(device.id)")
                    }
                }
                .padding(.vertical, AceTheme.Spacing.xxs)
            }
            if let problem = overview.devicesProblem { ServiceProblem(message: problem); Button("Retry") { Task { await read() } }.buttonStyle(.textAction()) }
            if model.canOperate, overview.devices.contains(where: { !$0.`self` }) {
                Button("Revoke all other devices…", role: .destructive) { revokingOthers = true }
            }
        } header: { InsetHeader("Paired with \(machine)") } footer: {
            Text("Phones, tablets and browsers that follow and steer agents. They run none themselves.")
        }

    }

    @ViewBuilder private func links(_ overview: FleetOverview) -> some View {
        let open = overview.pairings.filter { Date(timeIntervalSince1970: $0.expiresAt / 1000) > Date() }
        if !open.isEmpty || overview.pairingsProblem != nil {
            QuietGroup {
                ForEach(open) { pairing in
                    HStack(spacing: AceDesign.Space.related) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            Text(pairing.label).font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                            Text("\(pairing.line) · works until \(Date(timeIntervalSince1970: pairing.expiresAt / 1000).formatted(date: .omitted, time: .shortened))")
                                .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                        Spacer(minLength: AceDesign.Space.related)
                        if model.canOperate {
                            Button("Cancel") { Task { await run(["op": "cancelPairing", "id": pairing.id]) } }
                                .buttonStyle(.textAction())
                                .accessibilityIdentifier("devices.cancel.\(pairing.id)")
                        }
                    }
                }
                if let problem = overview.pairingsProblem { ServiceProblem(message: problem); Button("Retry") { Task { await read() } }.buttonStyle(.textAction()) }
            } header: { InsetHeader("Open pairing links") } footer: { Text("Each works once. Cancel one you shared by mistake.") }

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
        guard model.connection == "ready" else { problem = "Can’t reach this machine. Reconnect and retry."; return }
        do { overview = try await model.fleetOverview(machine: machine); problem = nil }
        catch { problem = error.localizedDescription }
    }
    private func run(_ request: [String: Any]) async {
        busy = true
        defer { busy = false }
        let answer = await model.fleet(request, machine: machine)
        if answer.ok { changes += 1; retryRequest = nil } else { retryRequest = request; notice = answer.message ?? "Couldn’t complete the request." }
        await read()
    }
}

/// Pair another device: name it, choose what it may do and how long the link and its access
/// last, then show the link as a QR code and its code to type, as the web's Pair a device.
struct PairDeviceView: View {
    let model: ClientModel
    let machine: String
    let choices: FleetOverview.Choices
    let done: () -> Void
    @State private var label = ""
    @State private var access = "operate"
    @State private var extras: Set<String> = []
    @State private var ttl = 5 * 60_000
    @State private var keeps = 0
    @State private var made: FleetAnswer?
    @State private var problem: String?
    @State private var making = false

    var body: some View {
        QuietPage {
            if let made, let url = made.url {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let expires = made.expiresAt, context.date.timeIntervalSince1970 * 1000 >= expires {
                        QuietGroup {
                            Text("Pairing link expired").font(AceDesign.Typeface.body)
                            Button("Renew link") { Task { await make() } }.buttonStyle(.textAction(.prominent)).disabled(making)
                        }
                    } else { result(made, url: url) }
                }
                if let problem { QuietGroup { ServiceProblem(message: problem); Button("Retry") { Task { await make() } }.buttonStyle(.textAction()) } }
            } else { form }
        }

        .smoothChange(made?.url)
        .smoothChange(access)
        .sensoryFeedback(.success, trigger: made?.url) { _, now in now != nil }
        .sensoryFeedback(.selection, trigger: access)
        .navigationTitle("Pair a device").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { done() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
            }
            if made == nil {
                ToolbarItem(placement: .confirmationAction) {
                    if making { WorkingMark(label: "Making") } else {
                        Button("Make link") { Task { await make() } }.accessibilityIdentifier("pair.make")
                    }
                }
            }
        }
    }

    @ViewBuilder private var form: some View {
        QuietGroup {
            TextField("Device name (optional)", text: $label).accessibilityIdentifier("pair.label")
        } footer: { Text("The device shows under this name on \(machine), instead of the one it gives itself.") }

        QuietGroup {
            ForEach(choices.access) { choice in
                Button { access = choice.id } label: {
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                        Image(systemName: access == choice.id ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(access == choice.id ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            Text(choice.label).foregroundStyle(AceDesign.Ink.primary)
                            Text(choice.note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(access == choice.id ? .isSelected : [])
                .accessibilityIdentifier("pair.access.\(choice.id)")
            }
        } header: { InsetHeader("Access") }

        QuietGroup {
            Picker("Link works for", selection: $ttl) { ForEach(choices.linkLifetimes) { Text($0.label).tag($0.value) } }
            Picker("Device keeps access", selection: $keeps) { ForEach(choices.deviceLifetimes) { Text($0.label).tag($0.value) } }
        } header: { InsetHeader("Time") }

        QuietGroup {
            ForEach(choices.extras) { extra in
                Toggle(isOn: Binding(get: { extras.contains(extra.id) }, set: { if $0 { extras.insert(extra.id) } else { extras.remove(extra.id) } })) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(extra.label)
                        Text(extra.note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .toggleStyle(.systemSwitch)
            }
        } header: { InsetHeader("Also allow") }

        if let problem { QuietGroup { ServiceProblem(message: problem) } }
    }

    @ViewBuilder private func result(_ made: FleetAnswer, url: String) -> some View {
        QuietGroup {
            VStack(spacing: AceDesign.Space.row) {
                if let image = Self.qr(url) {
                    Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                        .frame(maxWidth: AceDesign.Size.qrCode).padding(AceDesign.Space.row)
                        // A QR code needs its white quiet zone to scan, in either scheme: content.
                        .background(Color.white, in: AceDesign.Shape.block)
                        .accessibilityLabel("Pairing QR code")
                }
                if let code = made.codeText {
                    Text(code).font(AceDesign.Typeface.codeBody).textSelection(.enabled)
                        .accessibilityIdentifier("pair.code")
                }
                if let expires = made.expiresAt {
                    Text("Works once, until \(Date(timeIntervalSince1970: expires / 1000).formatted(date: .omitted, time: .shortened)).")
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, AceDesign.Space.related)
            if let link = URL(string: url) { ShareLink(item: link) { Text("Share link") } }
        } footer: { Text("Scan it with ace on the other device, or open the link there.") }

        QuietGroup { Button("Done") { done() } }
    }

    private func make() async {
        making = true; problem = nil
        defer { making = false }
        var request: [String: Any] = ["op": "pair", "access": access, "extras": Array(extras).sorted(), "ttlMs": ttl, "deviceTtlMs": keeps]
        if !label.trimmingCharacters(in: .whitespaces).isEmpty { request["label"] = label }
        let answer = await model.fleet(request, machine: machine)
        if answer.ok { made = answer } else { problem = answer.message }
    }

    nonisolated static func qr(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
