import SwiftUI

/// "Pause new work" on a machine's page, the desktop tray's control: one tap pauses or resumes.
/// Paused, running work finishes and new threads and messages wait; the quiet line says so.
/// Words come from `bridge/machine-admission.ts`.
struct MachineAdmissionRow: View {
    let model: ClientModel
    @State private var working = false
    @State private var problem: String?
    @State private var changes = 0

    var body: some View {
        if let admission = model.admission, admission.known {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if model.canOperate {
                    Button { set(!admission.paused) } label: {
                        HStack {
                            Text(admission.action).font(AceDesign.Typeface.body)
                                .foregroundStyle(admission.canChange ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                            Spacer(minLength: AceDesign.Space.related)
                            if working { WorkingMark().transition(.opacity) }
                        }
                        .frame(minHeight: AceDesign.Size.tap)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(working || !admission.canChange || model.connection != "ready")
                    .accessibilityIdentifier("machine.admission")
                }
                if let line = admission.line {
                    Text(line).font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .transition(.opacity)
                        .accessibilityIdentifier("machine.admission.line")
                }
                ServiceProblem(message: problem)
            }
            .smoothChange(admission)
            .smoothChange(working)
            .sensoryFeedback(.success, trigger: changes)
        }
    }

    private func set(_ paused: Bool) {
        working = true
        problem = nil
        Task {
            defer { working = false }
            do {
                // The patch that follows redraws the row; the reply only confirms it.
                _ = try await model.service(["type": "machine.admission.set", "paused": paused], as: MachineAdmissionInfo.self)
                changes += 1
            } catch is CancellationError {
            } catch { problem = error.localizedDescription }
        }
    }
}
