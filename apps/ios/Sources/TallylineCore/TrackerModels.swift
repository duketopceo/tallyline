import Foundation

/// Issue board models — mirror `apps/api` issue rows and the list/detail
/// response shapes the `/v1` routes return. Optional fields follow the
/// schema's nullable columns.
public enum IssueState: String, Codable, Sendable, CaseIterable {
    case triage, backlog, todo
    case inProgress = "in_progress"
    case inReview = "in_review"
    case done, canceled, duplicate
}

public enum IssuePriority: String, Codable, Sendable, CaseIterable {
    case none, urgent, high, medium, low
}

public struct Issue: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let key: String
    public let number: Int
    public let title: String
    public let description: String?
    public let state: IssueState
    public let priority: IssuePriority
    public let estimate: Int?
    public let dueDate: Date?
    public let assigneeType: String?
    public let assigneeId: String?
    public let delegateType: String?
    public let delegateId: String?
    public let creatorType: String
    public let creatorId: String?
    public let projectId: String?
    public let cycleId: String?
    public let parentId: String?
    public let source: String
    public let occurrenceCount: Int
    public let createdAt: Date
    public let updatedAt: Date
}

public struct IssueComment: Codable, Sendable, Identifiable {
    public let id: String
    public let issueId: String
    public let actorType: String
    public let actorId: String?
    public let body: String
    public let createdAt: Date
}

/// `GET /projects` returns the whole `projects` row. Everything past the
/// name is optional so an older or slimmer server still decodes.
public struct Project: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let description: String?
    public let status: String?
    public let teamId: String?
    public let iconUrl: String?
    public let startDate: Date?
    public let targetDate: Date?
    public let createdAt: Date?

    public init(id: String, name: String, description: String? = nil, status: String? = nil, teamId: String? = nil, iconUrl: String? = nil, startDate: Date? = nil, targetDate: Date? = nil, createdAt: Date? = nil) {
        self.id = id; self.name = name; self.description = description; self.status = status
        self.teamId = teamId; self.iconUrl = iconUrl; self.startDate = startDate
        self.targetDate = targetDate; self.createdAt = createdAt
    }
}

/// A dated step inside a project (`GET /milestones`). `progress` counts the
/// milestone's issues, canceled and duplicate excluded.
public struct Milestone: Codable, Sendable, Identifiable, Hashable {
    public struct Progress: Codable, Sendable, Hashable {
        public let total: Int
        public let done: Int
    }

    public let id: String
    public let projectId: String
    public let title: String
    public let targetDate: Date?
    public let done: Bool
    public let progress: Progress?
}

/// `GET /roadmap/summary`: exact counts per project and milestone, computed by
/// the server. Clients never derive these from the issues they happen to hold.
public struct RoadmapSummary: Codable, Sendable, Equatable {
    public struct Totals: Codable, Sendable, Equatable {
        public let issues: Int
        public let done: Int
        public let closed: Int
        public let doneSince: Int
    }

    public struct ProjectCounts: Codable, Sendable, Equatable, Identifiable {
        public let projectId: String
        public let total: Int
        public let done: Int
        public let closed: Int
        public let inProgress: Int
        public let inReview: Int
        public let doneSince: Int?
        public var id: String { projectId }
    }

    public struct MilestoneCounts: Codable, Sendable, Equatable, Identifiable {
        public let milestoneId: String
        public let total: Int
        public let done: Int
        public var id: String { milestoneId }
    }

    public struct PullRequest: Codable, Sendable, Equatable {
        public let number: Int
        public let url: String
        public let title: String?
        public let repo: String?
    }

    /// One thing that finished in the window: a PR merge or a move to done.
    public struct Merge: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let issueKey: String
        public let issueTitle: String
        public let projectId: String?
        public let actorName: String?
        public let actorType: String
        public let at: Date
        public let pr: PullRequest?
    }

    public let generatedAt: Date
    public let since: Date
    public let totals: Totals
    public let projects: [ProjectCounts]
    public let milestones: [MilestoneCounts]
    public let merges: [Merge]

    /// Counts for a project. A project the summary does not mention has no
    /// issues yet, so it reads as zero rather than missing.
    public func counts(forProject id: String) -> ProjectCounts {
        projects.first { $0.projectId == id }
            ?? ProjectCounts(projectId: id, total: 0, done: 0, closed: 0, inProgress: 0, inReview: 0, doneSince: nil)
    }

    public func counts(forMilestone id: String) -> MilestoneCounts {
        milestones.first { $0.milestoneId == id } ?? MilestoneCounts(milestoneId: id, total: 0, done: 0)
    }
}

public struct Cycle: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let number: Int?
    public let startsAt: Date?
    public let endsAt: Date?
    public let isActive: Bool
}

public struct Label: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let color: String?
}

public struct Team: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let key: String
}

public struct Member: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let email: String?
    public let role: String
}

public struct Agent: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let harness: String?
}

/// Review-queue row: an `in_review` issue with its most recent dispatch.
/// Flat, as `GET /review-queue` returns it.
public struct ReviewQueueEntry: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let key: String
    public let title: String
    public let priority: IssuePriority
    public let updatedAt: Date
    public let dispatchId: String
    public let dispatchStatus: String
    public let agentName: String
    public let sessionAt: Date
}

/// One page of `GET /issues`. With `updatedSince` it is a delta page, ordered
/// by change time; follow `nextCursor` until it is nil.
public struct IssuePage: Codable, Sendable {
    public let issues: [Issue]
    public let nextCursor: String?
}

// List envelopes. Every list route wraps its rows in a named key.
struct CommentList: Decodable { let comments: [IssueComment] }
struct ProjectList: Decodable { let projects: [Project] }
struct CycleList: Decodable { let cycles: [Cycle] }
struct LabelList: Decodable { let labels: [Label] }
struct TeamList: Decodable { let teams: [Team] }
struct MemberList: Decodable { let members: [Member] }
struct AgentList: Decodable { let agents: [Agent] }
struct ReviewQueueList: Decodable { let queue: [ReviewQueueEntry] }
struct MilestoneList: Decodable { let milestones: [Milestone] }

public extension Issue {
    /// The issue as it will look once `patch` lands, for optimistic display.
    /// The server's answer replaces it on the next sync.
    func applying(_ patch: IssuePatch, at now: Date = Date()) -> Issue {
        Issue(
            id: id, key: key, number: number,
            title: patch.title ?? title,
            description: patch.description ?? description,
            state: patch.state ?? state,
            priority: patch.priority ?? priority,
            estimate: patch.estimate ?? estimate,
            dueDate: dueDate,
            assigneeType: patch.assigneeId != nil ? (patch.assigneeType ?? "human") : assigneeType,
            assigneeId: patch.assigneeId ?? assigneeId,
            delegateType: patch.delegateType ?? delegateType,
            delegateId: patch.delegateId ?? delegateId,
            creatorType: creatorType, creatorId: creatorId,
            projectId: patch.projectId ?? projectId,
            cycleId: patch.cycleId ?? cycleId,
            parentId: parentId, source: source, occurrenceCount: occurrenceCount,
            createdAt: createdAt, updatedAt: now
        )
    }
}
