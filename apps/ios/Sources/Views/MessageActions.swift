import SwiftUI
import UIKit

/// What a message's actions do on the open thread. The bridge says which apply to a row
/// (`TranscriptRow.actions`, `TransitionsRow`); the thread screen supplies what they do. Nil where
/// messages offer only Copy (a lane sheet, a pushed message, a view-only machine).
struct MessageTransitions: Equatable {
    /// The thread's transitions: which answer Retry sits under, whether Pi can go back now.
    var row: TransitionsRow?
    let fork: (TranscriptRow) -> Void
    let edit: (TranscriptRow) -> Void
    let retry: (TranscriptRow) -> Void
    let rewind: (TranscriptRow) -> Void

    /// The row's actions beyond Copy, in the order the action row and long-press menu list them.
    func offered(for row: TranscriptRow) -> [MessageAction] {
        guard let actions = row.actions, row.complete else { return [] }
        var offered: [MessageAction] = []
        if actions.edit { offered.append(.edit) }
        if actions.fork { offered.append(.fork) }
        if self.row?.retry?.answerId == row.id { offered.append(.retry) }
        if actions.rewind, self.row?.settled == true, self.row?.retry?.answerId != row.id { offered.append(.rewind) }
        return offered
    }
    /// Equal when they offer the same: the closures act on the open thread whatever the render,
    /// so a redraw of the screen never redraws every message row.
    static func == (lhs: MessageTransitions, rhs: MessageTransitions) -> Bool { lhs.row == rhs.row }
    func run(_ action: MessageAction, _ row: TranscriptRow) {
        switch action {
        case .edit: edit(row)
        case .fork: fork(row)
        case .retry: retry(row)
        case .rewind: rewind(row)
        }
    }
}

enum MessageAction: CaseIterable {
    case edit, fork, retry, rewind
    var label: String {
        switch self {
        case .edit: "Edit"
        case .fork: "Fork from here"
        case .retry: "Retry"
        case .rewind: "Rewind to here"
        }
    }
    var icon: AceIcon.Name {
        switch self {
        case .edit: .pencilSimple
        case .fork: .gitFork
        case .retry: .arrowClockwise
        case .rewind: .clockCounterClockwise
        }
    }
    var identifier: String {
        switch self {
        case .edit: "edit"
        case .fork: "fork"
        case .retry: "retry"
        case .rewind: "rewind"
        }
    }
}

extension EnvironmentValues {
    @Entry var messageTransitions: MessageTransitions? = nil
}
