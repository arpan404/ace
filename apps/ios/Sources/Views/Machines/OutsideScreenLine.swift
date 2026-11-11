import SwiftUI

/// "Claude is using this Mac", with Stop, while an outside app uses a machine's screen
/// (ADR 0122). Stop ends its screen work at once and takes screen use off its access; the person
/// adds it back in Settings › Connected apps.
struct OutsideScreenLine: View {
    let client: ClientModel
    let use: OutsideClientsModel.ScreenUse
    /// The machine's name, for refusals; `named` also says it on the line, with several machines.
    let machine: String
    let named: Bool
    @State private var stopping = false
    @State private var problem: String?

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(named ? "\(use.line) · \(machine)" : use.line)
                    .aceFont(AceDesign.TextRole.segment, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground)
                if let problem {
                    Text(problem).font(AceDesign.Typeface.meta).foregroundStyle(AceTheme.Status.failed)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if stopping { WorkingMark(label: "Stopping") } else {
                Button("Stop") { Task { await stop() } }
                    .buttonStyle(NeedWordStyle(primary: true))
                    .accessibilityIdentifier("outside.screen.stop")
            }
        }
        .padding(.leading, AceDesign.Size.rowInset)
        .padding(.trailing, AceDesign.Size.rowInset - AceDesign.Space.stripWord)
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Stop") { Task { await stop() } }
        .accessibilityIdentifier("outside.screen")
    }

    private func stop() async {
        stopping = true; problem = nil
        defer { stopping = false }
        problem = await client.outsideChange(["op": "stopScreen", "grantId": use.grantId], machine: machine)
    }
}
