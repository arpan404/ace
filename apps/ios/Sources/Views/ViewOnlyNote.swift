import SwiftUI

/// Shown where an action would be when the computer paired this phone view-only.
struct ViewOnlyNote: View {
    let message: String
    var body: some View {
        Label(message, ace: .eye)
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("viewOnly.note")
    }
}

extension ViewOnlyNote {
    static let thread = ViewOnlyNote(message: "View only. Reply on your computer.")
    static let approval = ViewOnlyNote(message: "View only. Answer this on your computer, or pair this phone with View and act.")
    static let inbox = ViewOnlyNote(message: "View only. Archive and snooze need a View and act pairing.")
}
