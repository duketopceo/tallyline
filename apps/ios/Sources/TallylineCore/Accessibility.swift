import Foundation

/// WCAG 2.x contrast ratio, the measure the DESIGN.md floors use.
public enum Contrast {
    public static func ratio(_ a: SilverLiningRGBA, _ b: SilverLiningRGBA) -> Double {
        let la = luminance(a)
        let lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    static func luminance(_ c: SilverLiningRGBA) -> Double {
        func linear(_ v: Double) -> Double {
            v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(c.red) + 0.7152 * linear(c.green) + 0.0722 * linear(c.blue)
    }
}

extension IssueState {
    /// What people read and VoiceOver says: "In progress", not "in_progress".
    public var displayName: String {
        switch self {
        case .triage: "Triage"
        case .backlog: "Backlog"
        case .todo: "To do"
        case .inProgress: "In progress"
        case .inReview: "In review"
        case .done: "Done"
        case .canceled: "Canceled"
        case .duplicate: "Duplicate"
        }
    }
}

extension IssuePriority {
    public var displayName: String {
        switch self {
        case .urgent: "Urgent"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        case .none: "No priority"
        }
    }
}

/// One VoiceOver sentence per issue row, in reading order of importance.
public enum IssueSpeech {
    public static func label(_ issue: Issue) -> String {
        var parts = [issue.key, issue.title, issue.state.displayName]
        if issue.priority != .none { parts.append("\(issue.priority.displayName) priority") }
        if issue.creatorType == "agent" { parts.append("Created by an agent") }
        if issue.occurrenceCount > 1 { parts.append("Reported \(issue.occurrenceCount) times") }
        return parts.joined(separator: ", ")
    }
}
