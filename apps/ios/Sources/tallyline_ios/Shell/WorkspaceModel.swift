#if os(iOS)
import Foundation
import Observation
import TallylineCore

/// What the shell, Now, Projects, Roadmap and the pulse read: the roadmap
/// summary, review queue and pick-lists, fetched together in one refresh and
/// shared, so no screen asks the server for what another already has.
@MainActor @Observable
final class WorkspaceModel {
    private(set) var summary: RoadmapSummary?
    private(set) var review: [ReviewQueueEntry] = []
    private(set) var projects: [Project] = []
    private(set) var milestones: [Milestone] = []
    private(set) var cycles: [Cycle] = []
    private(set) var fetchedAt: Date?
    private(set) var failed = false

    /// Fetches everything at once. A part that fails keeps its last value.
    func refresh(client: APIClient?, workspaceSlug ws: String) async {
        guard let client else { return }
        async let s = try? client.roadmapSummary(ws: ws, since: Date().addingTimeInterval(-7 * 86_400))
        async let r = try? client.reviewQueue(ws: ws)
        async let p = try? client.projects(ws: ws)
        async let m = try? client.milestones(ws: ws)
        async let c = try? client.cycles(ws: ws)
        let (summary, review, projects, milestones, cycles) = await (s, r, p, m, c)
        if summary == nil && review == nil && projects == nil {
            failed = true
            return
        }
        failed = false
        if let summary { self.summary = summary }
        if let review { self.review = review }
        if let projects { self.projects = projects }
        if let milestones { self.milestones = milestones }
        if let cycles { self.cycles = cycles }
        fetchedAt = Date()
    }

    func reset() {
        summary = nil; review = []; projects = []; milestones = []; cycles = []
        fetchedAt = nil; failed = false
    }
}
#endif
