import CoreImage.CIFilterBuiltins
import SwiftUI

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
        List {
            Group {
                if let made, let url = made.url {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if let expires = made.expiresAt, context.date.timeIntervalSince1970 * 1000 >= expires {
                            Section {
                                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                                    Text("Pairing link expired").aceFont(AceDesign.TextRole.rowTitle)
                                    Button("Renew link") { Task { await make() } }.buttonStyle(.primaryAction).disabled(making)
                                }
                                .padding(.vertical, AceDesign.Space.tight)
                            }
                        } else { result(made, url: url) }
                    }
                    if let problem { ProblemRow(problem, id: "pair.problem") { Task { await make() } } }
                } else { form }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
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
        if let problem { ProblemRow(problem, id: "pair.problem") }
        Section {
            TextField("Device name (optional)", text: $label).accessibilityIdentifier("pair.label")
        } footer: { Text("The device shows under this name on \(machine), instead of the one it gives itself.") }

        Section {
            ForEach(choices.access) { choice in
                Button { access = choice.id } label: {
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(choice.label).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                            Text(choice.note).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: AceDesign.Space.related)
                        if access == choice.id {
                            Image(systemName: "checkmark").fontWeight(AceDesign.Typeface.strong)
                                .foregroundStyle(AceDesign.Ink.action).accessibilityHidden(true)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(access == choice.id ? .isSelected : [])
                .accessibilityIdentifier("pair.access.\(choice.id)")
            }
        } header: { InsetHeader("Access") }

        Section {
            Picker("Link works for", selection: $ttl) { ForEach(choices.linkLifetimes) { Text($0.label).tag($0.value) } }
            Picker("Device keeps access", selection: $keeps) { ForEach(choices.deviceLifetimes) { Text($0.label).tag($0.value) } }
        } header: { InsetHeader("Time") }

        if !choices.extras.isEmpty {
            Section {
                ForEach(choices.extras) { extra in
                    Toggle(isOn: Binding(get: { extras.contains(extra.id) }, set: { if $0 { extras.insert(extra.id) } else { extras.remove(extra.id) } })) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(extra.label)
                            Text(extra.note).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        }
                    }
                    .toggleStyle(.systemSwitch)
                }
            } header: { InsetHeader("Also allow") }
        }
    }

    @ViewBuilder private func result(_ made: FleetAnswer, url: String) -> some View {
        Section {
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
                HStack(spacing: AceDesign.Space.related) {
                    if let link = URL(string: url) {
                        ShareLink(item: link) { Text("Share link") }.buttonStyle(.secondaryAction)
                    }
                    Button("Done") { done() }.buttonStyle(.primaryAction)
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, AceDesign.Space.related)
        } footer: { Text("Scan it with ace on the other device, or open the link there.") }
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
