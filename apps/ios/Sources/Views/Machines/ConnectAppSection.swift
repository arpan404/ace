import SwiftUI

/// Connect an app, as web's machine settings have it (ADR 0122): the four addresses an outside
/// client can use, each with Copy while it serves, the relay's and Tailscale's own switch, why
/// one can't serve, your own URL to add or change, and the command a terminal agent's person runs.
/// The bridge (`bridge/outside-addresses.ts`) words the rows and checks what is typed.
struct ConnectAppSection: View {
    let model: ClientModel
    let machine: String
    /// Bumped by the page's pull-to-refresh, so another client's change shows here too.
    var refresh = 0
    @State private var addresses: OutsideAddresses?
    @State private var problem: String?
    @State private var saving = false
    @State private var copied: String?
    @State private var editing = false
    @State private var typed = ""

    var body: some View {
        Section {
            if let addresses {
                ForEach(addresses.rows) { row in address(row) }
                enroll(addresses.enroll)
            } else if problem == nil {
                SkeletonRows(count: 2, label: "Reading this machine's addresses").listRowInsets(EdgeInsets())
            }
            ServiceProblem(message: problem)
        } header: { InsetHeader("Connect an app") } footer: {
            Text("Paste an address into an app such as claude.ai. It signs in, and you approve it here.")
        }
        .insetRowBackground()
        .disabled(saving)
        .task(id: "\(model.connection)|\(refresh)") { await read() }
        .alert("Your own URL", isPresented: $editing) {
            TextField("https://ace.example.com", text: $typed)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .accessibilityIdentifier("connect.ownUrl.field")
            Button("Save") { change(["op": "setPublicUrl", "url": typed]) }
            if ownUrl != nil {
                Button("Remove", role: .destructive) { change(["op": "setPublicUrl", "url": NSNull()]) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The https address that reaches this machine's endpoint, such as a tunnel or Tailscale Funnel.") }
    }

    private var ownUrl: String? { addresses?.rows.first { $0.path == "custom" }?.ownUrl }

    @ViewBuilder private func address(_ row: OutsideAddresses.Row) -> some View {
        HStack(alignment: .center, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).font(AceDesign.Typeface.body)
                if let state = row.state {
                    if row.problem {
                        Text(state).font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.StatusText.needsYou)
                    } else if row.url != nil {
                        Text(state).font(AceDesign.Typeface.meta).monospaced().foregroundStyle(AceDesign.Ink.muted)
                            .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    } else {
                        Text(state).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                if let note = row.note {
                    Text(note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("connect.address.\(row.path)")
            Spacer(minLength: AceDesign.Space.related)
            if let url = row.url {
                Button(copied == url ? "Copied" : "Copy") { copy(url) }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("connect.address.\(row.path).copy")
            }
            if row.path == "custom" {
                Button(row.ownUrl == nil ? "Add" : "Change") { typed = row.ownUrl ?? ""; editing = true }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("connect.ownUrl.edit")
            }
            if let on = row.on {
                Toggle(row.title, isOn: Binding(get: { on }, set: { change(["op": "setPath", "path": row.path, "on": $0]) }))
                    .labelsHidden().toggleStyle(.systemSwitch)
                    .accessibilityIdentifier("connect.address.\(row.path).switch")
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
    }

    private func enroll(_ command: String) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            (Text("For a terminal agent, run ") + Text(command).monospaced())
                .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted).textSelection(.enabled)
            Spacer(minLength: AceDesign.Space.related)
            Button(copied == command ? "Copied" : "Copy") { copy(command) }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("connect.enroll.copy")
        }
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        withAnimation { copied = text }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        do { let next = try await model.outsideAddresses(machine: machine); withAnimation { addresses = next; problem = nil } }
        catch { problem = error.localizedDescription }
    }

    private func change(_ request: [String: Any]) {
        saving = true; problem = nil
        Task {
            defer { saving = false }
            let refusal = await model.outsideChange(request, machine: machine)
            await read()
            if let refusal { withAnimation { problem = refusal } }
        }
    }
}
