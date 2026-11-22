import SwiftUI

/// Routines: the bot's routines, each with when it runs.
struct SpadeProfileRoutines: View {
    let routines: SpadeProfile.Part<SpadeProfile.Routine>
    let name: String
    let retry: () -> Void

    var body: some View {
        Section("Routines") {
            SpadeProfileRows(part: routines, none: "\(name) has no routines yet.",
                             failed: "Couldn't read the routines.", retry: retry) { routine in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(routine.name).aceFont(AceDesign.TextRole.rowTitle)
                    Text(routine.line)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(routine.failed ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
