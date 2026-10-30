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

public struct Project: Codable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let status: String?
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
