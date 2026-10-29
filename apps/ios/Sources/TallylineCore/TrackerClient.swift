import Foundation

/// Typed `/v1` surface for the app's screens. Mutations take a client-generated
/// `Idempotency-Key` so outbox retries can't double-post (S4-U4 contract).
public struct IssueCreate: Encodable, Sendable {
    public var title: String
    public var description: String?
    public var teamId: String
    public var priority: IssuePriority?
    public var projectId: String?
    public var cycleId: String?
    public var parentId: String?
    public var delegateId: String?
    public var delegateType: String?

    public init(title: String = "", description: String? = nil, teamId: String = "", priority: IssuePriority? = nil, projectId: String? = nil, cycleId: String? = nil, parentId: String? = nil, delegateId: String? = nil, delegateType: String? = nil) {
        self.title = title; self.description = description; self.teamId = teamId; self.priority = priority
        self.projectId = projectId; self.cycleId = cycleId; self.parentId = parentId
        self.delegateId = delegateId; self.delegateType = delegateType
    }
}

public struct IssuePatch: Encodable, Sendable {
    public var title: String?
    public var description: String?
    public var state: IssueState?
    public var priority: IssuePriority?
    public var estimate: Int?
    public var assigneeId: String?
    public var delegateId: String?
    public var delegateType: String?
    public var projectId: String?
    public var cycleId: String?
}

public struct CommentCreate: Encodable, Sendable {
    public var body: String
    public var actorType: String = "human"
}

extension APIClient {
    /// Workspace-scoped path prefix.
    private func ws(_ slug: String) -> String { "/v1/workspaces/\(slug)" }

    // ── Issues ──────────────────────────────────────────────────────────

    public func issues(ws slug: String, state: IssueState? = nil, updatedSince: Date? = nil) async throws -> [Issue] {
        var q: [String: String] = [:]
        if let state { q["state"] = state.rawValue }
        if let updatedSince { q["updatedSince"] = ISO8601DateFormatter().string(from: updatedSince) }
        return try await send(method: "GET", path: "\(ws(slug))/issues", query: q)
    }

    public func issue(ws slug: String, key: String) async throws -> Issue {
        try await send(method: "GET", path: "\(ws(slug))/issues/\(key)")
    }

    public func createIssue(ws slug: String, _ draft: IssueCreate, idempotencyKey: String = UUID().uuidString) async throws -> Issue {
        try await send(method: "POST", path: "\(ws(slug))/issues", query: [:], body: draft, idempotencyKey: idempotencyKey)
    }

    public func updateIssue(ws slug: String, key: String, _ patch: IssuePatch, idempotencyKey: String = UUID().uuidString) async throws -> Issue {
        try await send(method: "PATCH", path: "\(ws(slug))/issues/\(key)", query: [:], body: patch, idempotencyKey: idempotencyKey)
    }

    public func comments(ws slug: String, key: String) async throws -> [IssueComment] {
        try await send(method: "GET", path: "\(ws(slug))/issues/\(key)/comments")
    }

    public func addComment(ws slug: String, key: String, body: String, idempotencyKey: String = UUID().uuidString) async throws -> IssueComment {
        try await send(method: "POST", path: "\(ws(slug))/issues/\(key)/comments", query: [:], body: CommentCreate(body: body), idempotencyKey: idempotencyKey)
    }

    /// Human-only review decision — approve or send back an `in_review` issue.
    public func reviewIssue(ws slug: String, key: String, decision: String, comment: String? = nil) async throws -> Issue {
        struct Body: Encodable { let decision: String; let comment: String? }
        return try await send(method: "POST", path: "\(ws(slug))/issues/\(key)/review", query: [:], body: Body(decision: decision, comment: comment))
    }

    // ── Board resources ─────────────────────────────────────────────────

    public func projects(ws slug: String) async throws -> [Project] {
        try await send(method: "GET", path: "\(ws(slug))/projects")
    }

    public func cycles(ws slug: String) async throws -> [Cycle] {
        try await send(method: "GET", path: "\(ws(slug))/cycles")
    }

    public func labels(ws slug: String) async throws -> [Label] {
        try await send(method: "GET", path: "\(ws(slug))/labels")
    }

    public func teams(ws slug: String) async throws -> [Team] {
        try await send(method: "GET", path: "\(ws(slug))/teams")
    }

    public func members(ws slug: String) async throws -> [Member] {
        try await send(method: "GET", path: "\(ws(slug))/members")
    }

    public func agents(ws slug: String) async throws -> [Agent] {
        try await send(method: "GET", path: "\(ws(slug))/agents")
    }

    public func reviewQueue(ws slug: String) async throws -> [ReviewQueueEntry] {
        try await send(method: "GET", path: "\(ws(slug))/review-queue")
    }
}
