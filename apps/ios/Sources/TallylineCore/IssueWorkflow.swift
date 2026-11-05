import Foundation

/// The lifecycle the server enforces (`packages/types` `state-machine.ts`),
/// mirrored so lists only offer moves the API will accept. The server stays
/// the authority: a refused move rolls back.
public extension IssueState {
    /// Every state this one may move to.
    var transitions: [IssueState] {
        switch self {
        case .triage: [.backlog, .canceled, .duplicate]
        case .backlog: [.todo, .canceled, .duplicate]
        case .todo: [.inProgress, .backlog, .canceled, .duplicate]
        case .inProgress: [.inReview, .backlog, .canceled, .duplicate]
        case .inReview: [.done, .inProgress, .canceled, .duplicate]
        case .done, .canceled, .duplicate: []
        }
    }

    /// The one-tap "next" move for a swipe. Review is decided on the detail
    /// screen (Approve / Send back), so it has none.
    var forward: IssueState? {
        switch self {
        case .triage: .backlog
        case .backlog: .todo
        case .todo: .inProgress
        case .inProgress: .inReview
        case .inReview, .done, .canceled, .duplicate: nil
        }
    }

    /// Where it sits in a grouped list: what needs a person first.
    var listOrder: Int {
        switch self {
        case .triage: 0
        case .inReview: 1
        case .inProgress: 2
        case .todo: 3
        case .backlog: 4
        case .done: 5
        case .canceled: 6
        case .duplicate: 7
        }
    }
}

public extension IssuePriority {
    /// Filled bars in the priority glyph (of three). None draws an empty one.
    var barCount: Int {
        switch self {
        case .urgent, .high: 3
        case .medium: 2
        case .low: 1
        case .none: 0
        }
    }

    /// Sort weight: urgent first.
    var rank: Int {
        switch self {
        case .urgent: 0
        case .high: 1
        case .medium: 2
        case .low: 3
        case .none: 4
        }
    }
}

public struct IssueSection: Equatable, Sendable {
    public let state: IssueState
    public let issues: [Issue]
}

public enum IssueGrouping {
    /// Groups by state in `listOrder`; inside a group, urgent first then newest.
    /// Empty groups are left out.
    public static func sections(_ issues: [Issue]) -> [IssueSection] {
        Dictionary(grouping: issues, by: \.state)
            .map { state, rows in
                IssueSection(state: state, issues: rows.sorted {
                    if $0.priority.rank != $1.priority.rank { return $0.priority.rank < $1.priority.rank }
                    return $0.updatedAt > $1.updatedAt
                })
            }
            .sorted { $0.state.listOrder < $1.state.listOrder }
    }
}

public enum ProgressMath {
    /// 0...1. A project with no issues is 0, never a division by zero.
    public static func fraction(done: Int, total: Int) -> Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, Double(done) / Double(total)))
    }
}
