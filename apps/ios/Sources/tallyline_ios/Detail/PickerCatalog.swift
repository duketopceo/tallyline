#if os(iOS)
import Observation
import TallylineCore

/// The pick-lists the detail screen and the composer offer: teams, projects,
/// cycles, labels, people and agents. Loaded once per screen; whatever fails
/// to load simply isn't offered, and the pill says so.
@MainActor @Observable
final class PickerCatalog {
    private(set) var teams: [Team] = []
    private(set) var projects: [Project] = []
    private(set) var cycles: [Cycle] = []
    private(set) var labels: [Label] = []
    private(set) var members: [Member] = []
    private(set) var agents: [Agent] = []
    private(set) var loaded = false

    func load(client: APIClient?, workspaceSlug ws: String) async {
        guard let client, !loaded else { return }
        async let t = try? client.teams(ws: ws)
        async let p = try? client.projects(ws: ws)
        async let c = try? client.cycles(ws: ws)
        async let l = try? client.labels(ws: ws)
        async let m = try? client.members(ws: ws)
        async let a = try? client.agents(ws: ws)
        let (teams, projects, cycles, labels, members, agents) = await (t, p, c, l, m, a)
        self.teams = teams ?? TeamMemory().teams
        self.projects = projects ?? []
        self.cycles = cycles ?? []
        self.labels = labels ?? []
        self.members = members ?? []
        self.agents = agents ?? []
        if !self.teams.isEmpty { TeamMemory().teams = self.teams }
        loaded = true
    }

    func team(_ id: String?) -> Team? { teams.first { $0.id == id } }
    func project(_ id: String?) -> Project? { projects.first { $0.id == id } }
    func cycle(_ id: String?) -> Cycle? { cycles.first { $0.id == id } }
    func agent(_ id: String?) -> Agent? { agents.first { $0.id == id } }
    func member(userId: String?) -> Member? { members.first { $0.userId == userId } }
}

extension Cycle {
    /// "Cycle 4", or the name when it has one.
    var title: String {
        if let name, !name.isEmpty { return name }
        return number.map { "Cycle \($0)" } ?? "Cycle"
    }
}

extension Member {
    var title: String { name ?? email ?? "Member" }
}
#endif
