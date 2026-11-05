import Foundation

/// Typed `/v1` surface for the app's screens. Mutations take a client-generated
/// `Idempotency-Key` so outbox retries can't double-post (S4-U4 contract).
public struct IssueCreate: Codable, Sendable, Equatable {
    public var title: String
    public var description: String?
    public var teamId: String
    /// The API picks the team by its key (`ENG`); without one it falls back to
    /// the workspace's first team. Callers that know the team send both.
    public var teamKey: String?
    /// Unset means the server default (backlog). The share sheet sends triage.
    public var state: IssueState?
    public var priority: IssuePriority?
    public var projectId: String?
    public var cycleId: String?
    public var parentId: String?
    public var assigneeType: String?
    public var assigneeId: String?
    public var delegateId: String?
    public var delegateType: String?
    public var labelIds: [String]?

    public init(title: String = "", description: String? = nil, teamId: String = "", teamKey: String? = nil, state: IssueState? = nil, priority: IssuePriority? = nil, projectId: String? = nil, cycleId: String? = nil, parentId: String? = nil, assigneeType: String? = nil, assigneeId: String? = nil, delegateId: String? = nil, delegateType: String? = nil, labelIds: [String]? = nil) {
        self.title = title; self.description = description; self.teamId = teamId; self.teamKey = teamKey; self.state = state; self.priority = priority
        self.projectId = projectId; self.cycleId = cycleId; self.parentId = parentId
        self.assigneeType = assigneeType; self.assigneeId = assigneeId
        self.delegateId = delegateId; self.delegateType = delegateType; self.labelIds = labelIds
    }
}

/// Fields a patch can set to null. `nil` on a plain property means "leave it
/// alone"; clearing has to be said out loud.
public enum IssuePatchClear: String, Codable, Sendable, CaseIterable {
    case assignee, project, cycle
}

public struct IssuePatch: Codable, Sendable, Equatable {
    public var title: String?
    public var description: String?
    public var state: IssueState?
    public var priority: IssuePriority?
    public var estimate: Int?
    public var assigneeType: String?
    public var assigneeId: String?
    public var delegateId: String?
    public var delegateType: String?
    public var projectId: String?
    public var cycleId: String?
    public var labelIds: [String]?
    /// Sent as JSON null so the server unassigns or detaches.
    public var cleared: Set<IssuePatchClear> = []

    public init(title: String? = nil, description: String? = nil, state: IssueState? = nil, priority: IssuePriority? = nil, estimate: Int? = nil, assigneeType: String? = nil, assigneeId: String? = nil, delegateId: String? = nil, delegateType: String? = nil, projectId: String? = nil, cycleId: String? = nil, labelIds: [String]? = nil, cleared: Set<IssuePatchClear> = []) {
        self.title = title; self.description = description; self.state = state; self.priority = priority; self.estimate = estimate
        self.assigneeType = assigneeType; self.assigneeId = assigneeId; self.delegateId = delegateId; self.delegateType = delegateType
        self.projectId = projectId; self.cycleId = cycleId; self.labelIds = labelIds; self.cleared = cleared
    }

    private enum CodingKeys: String, CodingKey {
        case title, description, state, priority, estimate, assigneeType, assigneeId
        case delegateId, delegateType, projectId, cycleId, labelIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        state = try c.decodeIfPresent(IssueState.self, forKey: .state)
        priority = try c.decodeIfPresent(IssuePriority.self, forKey: .priority)
        estimate = try c.decodeIfPresent(Int.self, forKey: .estimate)
        assigneeType = try c.decodeIfPresent(String.self, forKey: .assigneeType)
        assigneeId = try c.decodeIfPresent(String.self, forKey: .assigneeId)
        delegateId = try c.decodeIfPresent(String.self, forKey: .delegateId)
        delegateType = try c.decodeIfPresent(String.self, forKey: .delegateType)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        cycleId = try c.decodeIfPresent(String.self, forKey: .cycleId)
        labelIds = try c.decodeIfPresent([String].self, forKey: .labelIds)
        var cleared: Set<IssuePatchClear> = []
        if try c.contains(.assigneeId) && c.decodeNil(forKey: .assigneeId) { cleared.insert(.assignee) }
        if try c.contains(.projectId) && c.decodeNil(forKey: .projectId) { cleared.insert(.project) }
        if try c.contains(.cycleId) && c.decodeNil(forKey: .cycleId) { cleared.insert(.cycle) }
        self.cleared = cleared
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(state, forKey: .state)
        try c.encodeIfPresent(priority, forKey: .priority)
        try c.encodeIfPresent(estimate, forKey: .estimate)
        try c.encodeIfPresent(delegateId, forKey: .delegateId)
        try c.encodeIfPresent(delegateType, forKey: .delegateType)
        try c.encodeIfPresent(labelIds, forKey: .labelIds)
        if cleared.contains(.assignee) {
            try c.encodeNil(forKey: .assigneeType)
            try c.encodeNil(forKey: .assigneeId)
        } else {
            try c.encodeIfPresent(assigneeType, forKey: .assigneeType)
            try c.encodeIfPresent(assigneeId, forKey: .assigneeId)
        }
        if cleared.contains(.project) { try c.encodeNil(forKey: .projectId) } else { try c.encodeIfPresent(projectId, forKey: .projectId) }
        if cleared.contains(.cycle) { try c.encodeNil(forKey: .cycleId) } else { try c.encodeIfPresent(cycleId, forKey: .cycleId) }
    }
}

public struct CommentCreate: Encodable, Sendable {
    public var body: String
    public var actorType: String = "human"

    public init(body: String, actorType: String = "human") {
        self.body = body; self.actorType = actorType
    }
}

extension APIClient {
    /// Workspace-scoped path prefix.
    private func ws(_ slug: String) -> String { "/v1/workspaces/\(slug)" }

    // ── Issues ──────────────────────────────────────────────────────────

    /// One page of issues. Pass `cursor` from the previous page to continue.
    public func issuePage(ws slug: String, state: IssueState? = nil, updatedSince: Date? = nil, cursor: String? = nil) async throws -> IssuePage {
        var q: [String: String] = [:]
        if let state { q["state"] = state.rawValue }
        if let updatedSince { q["updatedSince"] = APIDate.format(updatedSince) }
        if let cursor { q["cursor"] = cursor }
        return try await send(method: "GET", path: "\(ws(slug))/issues", query: q)
    }

    /// All matching issues, following cursors (bounded so a bad cursor cannot loop forever).
    public func issues(ws slug: String, state: IssueState? = nil, updatedSince: Date? = nil, maxPages: Int = 20) async throws -> [Issue] {
        var out: [Issue] = []
        var cursor: String?
        for _ in 0..<maxPages {
            let page = try await issuePage(ws: slug, state: state, updatedSince: updatedSince, cursor: cursor)
            out.append(contentsOf: page.issues)
            guard let next = page.nextCursor else { break }
            cursor = next
        }
        return out
    }

    public func issue(ws slug: String, key: String) async throws -> Issue {
        try await send(method: "GET", path: "\(ws(slug))/issues/\(key)")
    }

    public func createIssue(ws slug: String, _ draft: IssueCreate, idempotencyKey: String = UUID().uuidString) async throws -> Issue {
        try await send(method: "POST", path: "\(ws(slug))/issues", query: [:], body: draft, idempotencyKey: idempotencyKey)
    }

    /// `ifMatchVersion` is the issue `version` the edit was made against; a
    /// newer server issue answers `APIClientError.staleWrite`. Nil sends no
    /// precondition (and is what a server without the write contract needs).
    public func updateIssue(ws slug: String, key: String, _ patch: IssuePatch, idempotencyKey: String = UUID().uuidString, ifMatchVersion: Int? = nil) async throws -> Issue {
        try await send(method: "PATCH", path: "\(ws(slug))/issues/\(key)", query: [:], body: patch, idempotencyKey: idempotencyKey, ifMatchVersion: ifMatchVersion)
    }

    public func comments(ws slug: String, key: String) async throws -> [IssueComment] {
        let list: CommentList = try await send(method: "GET", path: "\(ws(slug))/issues/\(key)/comments")
        return list.comments
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
        let list: ProjectList = try await send(method: "GET", path: "\(ws(slug))/projects")
        return list.projects
    }

    /// Exact counts per project and milestone, plus what finished since `since`
    /// (the server defaults to the last 24 hours).
    public func roadmapSummary(ws slug: String, since: Date? = nil) async throws -> RoadmapSummary {
        var q: [String: String] = [:]
        if let since { q["since"] = APIDate.format(since) }
        return try await send(method: "GET", path: "\(ws(slug))/roadmap/summary", query: q)
    }

    /// Starts a project. Everything but the name takes the server's default.
    public func createProject(ws slug: String, name: String) async throws -> Project {
        struct Body: Encodable { let name: String }
        return try await send(method: "POST", path: "\(ws(slug))/projects", query: [:], body: Body(name: name))
    }

    /// Every milestone in the workspace, with issue progress.
    public func milestones(ws slug: String) async throws -> [Milestone] {
        let list: MilestoneList = try await send(method: "GET", path: "\(ws(slug))/milestones")
        return list.milestones
    }

    public func cycles(ws slug: String) async throws -> [Cycle] {
        let list: CycleList = try await send(method: "GET", path: "\(ws(slug))/cycles")
        return list.cycles
    }

    public func labels(ws slug: String) async throws -> [Label] {
        let list: LabelList = try await send(method: "GET", path: "\(ws(slug))/labels")
        return list.labels
    }

    public func teams(ws slug: String) async throws -> [Team] {
        let list: TeamList = try await send(method: "GET", path: "\(ws(slug))/teams")
        return list.teams
    }

    public func members(ws slug: String) async throws -> [Member] {
        let list: MemberList = try await send(method: "GET", path: "\(ws(slug))/members")
        return list.members
    }

    public func agents(ws slug: String) async throws -> [Agent] {
        let list: AgentList = try await send(method: "GET", path: "\(ws(slug))/agents")
        return list.agents
    }

    public func reviewQueue(ws slug: String) async throws -> [ReviewQueueEntry] {
        let list: ReviewQueueList = try await send(method: "GET", path: "\(ws(slug))/review-queue")
        return list.queue
    }
}
