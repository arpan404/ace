import SwiftUI

/// Asks for an account machine's machine code when its daemon refuses this phone without it
/// (ADR 0111). The typed code goes to that machine's next connection and nowhere else; the field
/// clears as soon as it is sent.
struct MachineCodePrompt: ViewModifier {
    let inbox: MachineInbox
    @State private var code = ""

    func body(content: Content) -> some View {
        let asking = inbox.sessions.first { $0.client.machineCodeAsk != nil && !$0.client.machineCodeDeferred }
        let ask = asking?.client.machineCodeAsk
        let name = asking.map { inbox.names[$0.hostId] ?? "this machine" } ?? "this machine"
        content.alert(ask == .locked ? "Code entry paused" : "Machine code for \(name)",
                      isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking?.client.machineCodeDeferred = true } })) {
            if ask?.canEnter == true {
                SecureField("Machine code", text: $code)
                    .textContentType(.password)
                    .accessibilityIdentifier("machineCode.field")
                Button("Not now", role: .cancel) { code = ""; asking?.client.machineCodeDeferred = true }
                Button("Open") {
                    let typed = code
                    code = ""
                    asking?.client.enterMachineCode(typed)
                }
                .accessibilityIdentifier("machineCode.open")
            } else {
                Button("OK", role: .cancel) { asking?.client.machineCodeDeferred = true }
            }
        } message: {
            Text(ask?.message ?? "")
        }
    }
}

extension View {
    func machineCodePrompt(_ inbox: MachineInbox) -> some View { modifier(MachineCodePrompt(inbox: inbox)) }
}
