import type {
	IAllExecuteFunctions,
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import {
	buildIssueCreateBody,
	buildIssueListQuery,
	buildIssueUpdateBody,
	rlcValue,
} from "../../lib/params";
import {
	extractList,
	num,
	str,
	workspaceUrl,
	type TallylineCredentialShape,
} from "../../lib/transport";

type RequestContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions;

async function getCredentials(
	ctx: RequestContext,
): Promise<TallylineCredentialShape> {
	return ctx.getCredentials<TallylineCredentialShape>("tallylineApi");
}

/** Authenticated workspace-scoped request against the tallyline API. */
async function apiRequest(
	ctx: RequestContext,
	options: {
		method?: IHttpRequestMethods;
		path: string;
		qs?: Record<string, string | number>;
		body?: IDataObject;
	},
): Promise<unknown> {
	const credentials = await getCredentials(ctx);
	const requestOptions: IHttpRequestOptions = {
		method: options.method ?? "GET",
		url: workspaceUrl(credentials, options.path),
		json: true,
	};
	if (options.qs !== undefined) requestOptions.qs = options.qs as IDataObject;
	if (options.body !== undefined) requestOptions.body = options.body;
	return ctx.helpers.httpRequestWithAuthentication.call(
		ctx as IAllExecuteFunctions,
		"tallylineApi",
		requestOptions,
	);
}

const ISSUE_STATE_OPTIONS: INodePropertyOptions[] = [
	{ name: "Triage", value: "triage" },
	{ name: "Backlog", value: "backlog" },
	{ name: "Todo", value: "todo" },
	{ name: "In Progress", value: "in_progress" },
	{ name: "In Review", value: "in_review" },
	{ name: "Done", value: "done" },
	{ name: "Canceled", value: "canceled" },
	{ name: "Duplicate", value: "duplicate" },
];

const PRIORITY_OPTIONS: INodePropertyOptions[] = [
	{ name: "None", value: "none" },
	{ name: "Low", value: "low" },
	{ name: "Medium", value: "medium" },
	{ name: "High", value: "high" },
	{ name: "Urgent", value: "urgent" },
];

const ASSIGNEE_TYPE_OPTIONS: INodePropertyOptions[] = [
	{ name: "Human", value: "human" },
	{ name: "Agent", value: "agent" },
];

export class Tallyline implements INodeType {
	description: INodeTypeDescription = {
		displayName: "tallyline",
		name: "tallyline",
		icon: "file:tallyline.svg",
		group: ["transform"],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			"Create, update, triage and comment on tallyline issues, and list workspace resources",
		defaults: { name: "tallyline" },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: "tallylineApi", required: true }],
		properties: [
			{
				displayName: "Resource",
				name: "resource",
				type: "options",
				noDataExpression: true,
				default: "issue",
				options: [
					{ name: "Agent", value: "agent" },
					{ name: "Cycle", value: "cycle" },
					{ name: "Intake", value: "intake" },
					{ name: "Issue", value: "issue" },
					{ name: "Label", value: "label" },
					{ name: "Project", value: "project" },
					{ name: "Team", value: "team" },
				],
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["issue"] } },
				default: "getAll",
				options: [
					{
						name: "Add Comment",
						value: "addComment",
						description: "Post a comment on an issue",
						action: "Add comment to issue",
					},
					{
						name: "Create",
						value: "create",
						description: "Create an issue (lands in backlog or triage)",
						action: "Create issue",
					},
					{
						name: "Get",
						value: "get",
						description: "Get one issue by key",
						action: "Get issue",
					},
					{
						name: "Get Comments",
						value: "getComments",
						description: "List comments on an issue",
						action: "Get issue comments",
					},
					{
						name: "Get Events",
						value: "getEvents",
						description: "Get the issue's audit/event feed",
						action: "Get issue events",
					},
					{
						name: "Get Many",
						value: "getAll",
						description: "List and search issues with filters",
						action: "Get many issues",
					},
					{
						name: "Triage",
						value: "triage",
						description:
							"Accept (to backlog) or decline (to canceled) an issue in triage",
						action: "Triage issue",
					},
					{
						name: "Update",
						value: "update",
						description:
							"Update issue fields — state changes route through the lifecycle",
						action: "Update issue",
					},
				],
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["intake"] } },
				default: "submit",
				options: [
					{
						name: "Submit Event",
						value: "submit",
						description:
							"Send a feedback or error event into the intake pipeline — dedupes by fingerprint and lands in triage",
						action: "Submit intake event",
					},
				],
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: {
					show: { resource: ["team", "project", "cycle", "label", "agent"] },
				},
				default: "getAll",
				options: [
					{
						name: "Get Many",
						value: "getAll",
						description: "List all records of this resource",
						action: "Get many",
					},
				],
			},

			// ── intake: submit params ────────────────────────────
			{
				displayName: "Kind",
				name: "intakeKind",
				type: "options",
				required: true,
				default: "error",
				displayOptions: {
					show: { resource: ["intake"], operation: ["submit"] },
				},
				options: [
					{ name: "Error", value: "error" },
					{ name: "Bug", value: "bug" },
					{ name: "Help", value: "help" },
					{ name: "Issue", value: "issue" },
				],
			},
			{
				displayName: "Title",
				name: "intakeTitle",
				type: "string",
				required: true,
				default: "",
				displayOptions: {
					show: { resource: ["intake"], operation: ["submit"] },
				},
			},
			{
				displayName: "Details",
				name: "intakeFields",
				type: "collection",
				default: {},
				placeholder: "Add Field",
				displayOptions: {
					show: { resource: ["intake"], operation: ["submit"] },
				},
				options: [
					{ displayName: "Body", name: "body", type: "string", default: "", typeOptions: { rows: 4 } },
					{ displayName: "Provider", name: "provider", type: "string", default: "", description: "Source system name (sentry, glitchtip, helpdesk…)" },
					{ displayName: "Fingerprint", name: "fingerprint", type: "string", default: "", description: "Dedupe key — repeated reports bump occurrence count instead of new issues" },
					{ displayName: "External ID", name: "externalId", type: "string", default: "", description: "Delivery idempotency key from the source" },
					{ displayName: "URL", name: "url", type: "string", default: "" },
					{
						displayName: "Severity", name: "severity", type: "options", default: "",
						options: [
							{ name: "Unset", value: "" },
							{ name: "Fatal", value: "fatal" },
							{ name: "Error", value: "error" },
							{ name: "Warning", value: "warning" },
							{ name: "Info", value: "info" },
						],
					},
				],
			},

			// ── issue: shared key param ────────────────────────────
			{
				displayName: "Issue Key",
				name: "issueKey",
				type: "string",
				required: true,
				default: "",
				placeholder: "ENG-42",
				displayOptions: {
					show: {
						resource: ["issue"],
						operation: [
							"get",
							"update",
							"triage",
							"addComment",
							"getComments",
							"getEvents",
						],
					},
				},
				description: "Human-readable issue key (TEAM-n)",
			},

			// ── issue: getAll ──────────────────────────────────────
			{
				displayName: "Return All",
				name: "returnAll",
				type: "boolean",
				default: false,
				displayOptions: {
					show: { resource: ["issue"], operation: ["getAll"] },
				},
				description: "Whether to return all results or only up to a given limit",
			},
			{
				displayName: "Limit",
				name: "limit",
				type: "number",
				default: 50,
				typeOptions: { maxValue: 200 },
				displayOptions: {
					show: {
						resource: ["issue"],
						operation: ["getAll"],
						returnAll: [false],
					},
				},
				description: "Max number of results to return (API max 200)",
			},
			{
				displayName: "Filters",
				name: "filters",
				type: "collection",
				placeholder: "Add Filter",
				default: {},
				displayOptions: {
					show: { resource: ["issue"], operation: ["getAll"] },
				},
				options: [
					{
						displayName: "State",
						name: "state",
						type: "options",
						default: "",
						options: [
							{ name: "Any", value: "" },
							...ISSUE_STATE_OPTIONS,
						],
					},
					{
						displayName: "Priority",
						name: "priority",
						type: "options",
						default: "",
						options: [{ name: "Any", value: "" }, ...PRIORITY_OPTIONS],
					},
					{
						displayName: "Team",
						name: "team",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getTeams" },
						description: "Team key to filter by",
					},
					{
						displayName: "Cycle",
						name: "cycle",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getCycles" },
					},
					{
						displayName: "Project",
						name: "project",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getProjects" },
					},
					{
						displayName: "Label",
						name: "label",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getLabels" },
					},
					{
						displayName: "Assignee ID",
						name: "assignee",
						type: "string",
						default: "",
						description: "Filter by assignee UUID (human or agent)",
					},
					{
						displayName: "Source",
						name: "source",
						type: "options",
						default: "",
						options: [
							{ name: "Any", value: "" },
							{ name: "Web", value: "web" },
							{ name: "GitHub", value: "github" },
							{ name: "Slack", value: "slack" },
							{ name: "API", value: "api" },
							{ name: "Voice", value: "voice" },
						],
					},
					{
						displayName: "Search",
						name: "search",
						type: "string",
						default: "",
						description: "Full-text search across title and description",
					},
				],
			},

			// ── issue: create ──────────────────────────────────────
			{
				displayName: "Team",
				name: "teamKey",
				type: "options",
				required: true,
				default: "",
				typeOptions: { loadOptionsMethod: "getTeams" },
				displayOptions: {
					show: { resource: ["issue"], operation: ["create"] },
				},
				description: "Team that owns the issue (mints the TEAM-n key)",
			},
			{
				displayName: "Title",
				name: "title",
				type: "string",
				required: true,
				default: "",
				displayOptions: {
					show: { resource: ["issue"], operation: ["create"] },
				},
			},
			{
				displayName: "Additional Fields",
				name: "additionalFields",
				type: "collection",
				placeholder: "Add Field",
				default: {},
				displayOptions: {
					show: { resource: ["issue"], operation: ["create"] },
				},
				options: [
					{
						displayName: "Assignee Type",
						name: "assigneeType",
						type: "options",
						default: "",
						options: [{ name: "Unassigned", value: "" }, ...ASSIGNEE_TYPE_OPTIONS],
					},
					{
						displayName: "Assignee",
						name: "assignee",
						type: "resourceLocator",
						default: { mode: "list", value: "" },
						description:
							"Pick an agent from the list or paste a human member UUID",
						modes: [
							{
								displayName: "Agent",
								name: "list",
								type: "list",
								placeholder: "Select an agent…",
								typeOptions: {
									searchListMethod: "getAgents",
									searchable: true,
								},
							},
							{
								displayName: "By ID",
								name: "id",
								type: "string",
								placeholder: "e.g. 8f2d…",
							},
						],
					},
					{
						displayName: "Cycle",
						name: "cycleId",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getCycles" },
					},
					{
						displayName: "Description",
						name: "description",
						type: "string",
						typeOptions: { rows: 4 },
						default: "",
					},
					{
						displayName: "Labels",
						name: "labelIds",
						type: "multiOptions",
						default: [],
						typeOptions: { loadOptionsMethod: "getLabels" },
					},
					{
						displayName: "Parent Issue ID",
						name: "parentId",
						type: "string",
						default: "",
						description: "UUID of the parent issue (sub-issue)",
					},
					{
						displayName: "Priority",
						name: "priority",
						type: "options",
						default: "",
						options: [
							{ name: "Default (None)", value: "" },
							...PRIORITY_OPTIONS,
						],
					},
					{
						displayName: "Project",
						name: "projectId",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getProjects" },
					},
					{
						displayName: "State",
						name: "state",
						type: "options",
						default: "",
						options: [
							{ name: "Default (Backlog)", value: "" },
							{ name: "Triage", value: "triage" },
							{ name: "Backlog", value: "backlog" },
						],
						description:
							"External intake conventionally lands in triage; the API defaults to backlog",
					},
				],
			},

			// ── issue: update ──────────────────────────────────────
			{
				displayName: "Update Fields",
				name: "updateFields",
				type: "collection",
				placeholder: "Add Field",
				default: {},
				displayOptions: {
					show: { resource: ["issue"], operation: ["update"] },
				},
				options: [
					{
						displayName: "Assignee Type",
						name: "assigneeType",
						type: "options",
						default: "",
						options: [
							{ name: "No Change", value: "" },
							...ASSIGNEE_TYPE_OPTIONS,
						],
						description:
							"To un-assign, use Fields to Clear → Assignee instead",
					},
					{
						displayName: "Assignee",
						name: "assignee",
						type: "resourceLocator",
						default: { mode: "list", value: "" },
						description:
							"Pick an agent from the list or paste a human member UUID",
						modes: [
							{
								displayName: "Agent",
								name: "list",
								type: "list",
								placeholder: "Select an agent…",
								typeOptions: {
									searchListMethod: "getAgents",
									searchable: true,
								},
							},
							{
								displayName: "By ID",
								name: "id",
								type: "string",
								placeholder: "e.g. 8f2d…",
							},
						],
					},
					{
						displayName: "Cycle",
						name: "cycleId",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getCycles" },
					},
					{
						displayName: "Description",
						name: "description",
						type: "string",
						typeOptions: { rows: 4 },
						default: "",
					},
					{
						displayName: "Due Date",
						name: "dueDate",
						type: "dateTime",
						default: "",
					},
					{
						displayName: "Estimate",
						name: "estimate",
						type: "number",
						default: "",
						description:
							"Story-point estimate (integer). Leave blank to keep unchanged; clear via Fields to Clear.",
					},
					{
						displayName: "Fields to Clear",
						name: "clearFields",
						type: "multiOptions",
						default: [],
						options: [
							{ name: "Assignee", value: "assignee" },
							{ name: "Cycle", value: "cycle" },
							{ name: "Description", value: "description" },
							{ name: "Due Date", value: "dueDate" },
							{ name: "Estimate", value: "estimate" },
							{ name: "Parent", value: "parent" },
							{ name: "Project", value: "project" },
						],
						description: "Fields sent as null to un-set their values",
					},
					{
						displayName: "Parent Issue ID",
						name: "parentId",
						type: "string",
						default: "",
					},
					{
						displayName: "Priority",
						name: "priority",
						type: "options",
						default: "",
						options: [{ name: "No Change", value: "" }, ...PRIORITY_OPTIONS],
					},
					{
						displayName: "Project",
						name: "projectId",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getProjects" },
					},
					{
						displayName: "State",
						name: "state",
						type: "options",
						default: "",
						options: [
							{ name: "No Change", value: "" },
							...ISSUE_STATE_OPTIONS,
						],
						description:
							"Illegal transitions return 409 — see the lifecycle in DESIGN.md",
					},
					{
						displayName: "Title",
						name: "title",
						type: "string",
						default: "",
					},
				],
			},

			// ── issue: triage ──────────────────────────────────────
			{
				displayName: "Action",
				name: "triageAction",
				type: "options",
				required: true,
				default: "accept",
				displayOptions: {
					show: { resource: ["issue"], operation: ["triage"] },
				},
				options: [
					{
						name: "Accept",
						value: "accept",
						description: "Move the issue from triage to backlog",
					},
					{
						name: "Decline",
						value: "decline",
						description: "Move the issue from triage to canceled",
					},
				],
			},

			// ── issue: addComment ──────────────────────────────────
			{
				displayName: "Comment",
				name: "commentBody",
				type: "string",
				typeOptions: { rows: 4 },
				required: true,
				default: "",
				displayOptions: {
					show: { resource: ["issue"], operation: ["addComment"] },
				},
			},

			// ── cycle: getAll options ──────────────────────────────
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: {
					show: { resource: ["cycle"], operation: ["getAll"] },
				},
				options: [
					{
						displayName: "Team",
						name: "team",
						type: "options",
						default: "",
						typeOptions: { loadOptionsMethod: "getTeams" },
						description: "Only return cycles for this team",
					},
					{
						displayName: "Active Only",
						name: "activeOnly",
						type: "boolean",
						default: false,
						description:
							"Only return the team's flagged active cycle",
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getTeams(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const rows = extractList(
					await apiRequest(this, { path: "/teams" }),
					"teams",
				);
				return rows
					.map((row) => ({
						name: `${str(row, "name") ?? "?"} (${str(row, "key") ?? "?"})`,
						value: str(row, "key") ?? "",
					}))
					.filter((o) => o.value !== "");
			},
			async getProjects(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const rows = extractList(
					await apiRequest(this, { path: "/projects" }),
					"projects",
				);
				return rows
					.map((row) => ({
						name: str(row, "name") ?? "?",
						value: str(row, "id") ?? "",
					}))
					.filter((o) => o.value !== "");
			},
			async getCycles(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const rows = extractList(
					await apiRequest(this, { path: "/cycles" }),
					"cycles",
				);
				return rows
					.map((row) => {
						const number = num(row, "number");
						const name = str(row, "name");
						const label =
							(name ?? `Cycle ${number ?? "?"}`) +
							(rowActive(row) ? " (active)" : "");
						return { name: label, value: str(row, "id") ?? "" };
					})
					.filter((o) => o.value !== "");
			},
			async getLabels(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const rows = extractList(
					await apiRequest(this, { path: "/labels" }),
					"labels",
				);
				return rows
					.map((row) => ({
						name: str(row, "name") ?? "?",
						value: str(row, "id") ?? "",
					}))
					.filter((o) => o.value !== "");
			},
		},
		listSearch: {
			async getAgents(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const rows = extractList(
					await apiRequest(this, { path: "/agents" }),
					"agents",
				);
				const needle = filter?.toLowerCase();
				const results = rows
					.map((row) => {
						const name = str(row, "name") ?? "?";
						const harness = str(row, "harness");
						return {
							name: harness ? `${name} (${harness})` : name,
							value: str(row, "id") ?? "",
						};
					})
					.filter((o) => o.value !== "")
					.filter((o) => !needle || o.name.toLowerCase().includes(needle));
				return { results };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter("resource", 0) as string;
		const operation = this.getNodeParameter("operation", 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const response = await runOperation(this, resource, operation, i);
				const rows = Array.isArray(response) ? response : [response];
				returnData.push(
					...this.helpers.returnJsonArray(rows as IDataObject[]),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					const message =
						error instanceof Error ? error.message : "Unknown error";
					returnData.push({ json: { error: message } });
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

function rowActive(row: unknown): boolean {
	if (typeof row === "object" && row !== null) {
		return (row as Record<string, unknown>).isActive === true;
	}
	return false;
}

async function runOperation(
	ctx: IExecuteFunctions,
	resource: string,
	operation: string,
	itemIndex: number,
): Promise<unknown> {
	if (resource === "issue") {
		return runIssueOperation(ctx, operation, itemIndex);
	}
	if (resource === "intake") {
		if (operation !== "submit") {
			throw new NodeOperationError(
				ctx.getNode(),
				`Unknown intake operation '${operation}'`,
			);
		}
		const fields = ctx.getNodeParameter(
			"intakeFields",
			itemIndex,
			{},
		) as IDataObject;
		const body: IDataObject = {
			kind: ctx.getNodeParameter("intakeKind", itemIndex) as string,
			title: ctx.getNodeParameter("intakeTitle", itemIndex) as string,
		};
		for (const f of ["body", "provider", "fingerprint", "externalId", "url", "severity"] as const) {
			const v = fields[f];
			if (typeof v === "string" && v !== "") body[f] = v;
		}
		return apiRequest(ctx, {
			method: "POST",
			path: "/intake",
			body,
		});
	}
	if (operation !== "getAll") {
		throw new NodeOperationError(
			ctx.getNode(),
			`Operation '${operation}' is not supported for resource '${resource}'`,
		);
	}
	switch (resource) {
		case "team":
			return extractList(await apiRequest(ctx, { path: "/teams" }), "teams");
		case "project":
			return extractList(
				await apiRequest(ctx, { path: "/projects" }),
				"projects",
			);
		case "cycle": {
			const options = ctx.getNodeParameter("options", itemIndex, {}) as IDataObject;
			const qs: Record<string, string | number> = {};
			if (typeof options.team === "string" && options.team !== "") {
				qs.team = options.team;
			}
			if (options.activeOnly === true) qs.active = "true";
			return extractList(
				await apiRequest(ctx, { path: "/cycles", qs }),
				"cycles",
			);
		}
		case "label":
			return extractList(
				await apiRequest(ctx, { path: "/labels" }),
				"labels",
			);
		case "agent":
			return extractList(
				await apiRequest(ctx, { path: "/agents" }),
				"agents",
			);
		default:
			throw new NodeOperationError(
				ctx.getNode(),
				`Unknown resource '${resource}'`,
			);
	}
}

async function runIssueOperation(
	ctx: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<unknown> {
	const keyParam = () =>
		encodeURIComponent(ctx.getNodeParameter("issueKey", itemIndex) as string);

	switch (operation) {
		case "get":
			return apiRequest(ctx, { path: `/issues/${keyParam()}` });
		case "getAll": {
			const filters = ctx.getNodeParameter(
				"filters",
				itemIndex,
				{},
			) as IDataObject;
			const returnAll = ctx.getNodeParameter(
				"returnAll",
				itemIndex,
				false,
			) as boolean;
			const limit = ctx.getNodeParameter("limit", itemIndex, 50) as number;
			const collected: unknown[] = [];
			let cursor: string | undefined;
			do {
				const qs = buildIssueListQuery(filters, returnAll ? 200 : limit);
				if (cursor !== undefined) qs.cursor = cursor;
				const page = (await apiRequest(ctx, {
					path: "/issues",
					qs,
				})) as Record<string, unknown>;
				collected.push(...extractList(page, "issues"));
				const next = page.nextCursor;
				cursor = typeof next === "string" && next !== "" ? next : undefined;
			} while (returnAll && cursor !== undefined);
			return returnAll ? collected : collected.slice(0, limit);
		}
		case "create": {
			const fields = ctx.getNodeParameter(
				"additionalFields",
				itemIndex,
				{},
			) as IDataObject;
			const assigneeType =
				typeof fields.assigneeType === "string" ? fields.assigneeType : "";
			const assigneeId = rlcValue(fields.assignee);
			if (assigneeType !== "" && assigneeId === "") {
				throw new NodeOperationError(
					ctx.getNode(),
					"An assignee is required when Assignee Type is set",
					{ itemIndex },
				);
			}
			const body = buildIssueCreateBody({
				teamKey: ctx.getNodeParameter("teamKey", itemIndex) as string,
				title: ctx.getNodeParameter("title", itemIndex) as string,
				...fields,
				assigneeType,
				assigneeId,
			});
			return apiRequest(ctx, {
				method: "POST",
				path: "/issues",
				body: body as IDataObject,
			});
		}
		case "update": {
			const fields = ctx.getNodeParameter(
				"updateFields",
				itemIndex,
				{},
			) as IDataObject;
			const assigneeType =
				typeof fields.assigneeType === "string" ? fields.assigneeType : "";
			const assigneeId = rlcValue(fields.assignee);
			if (assigneeType !== "" && assigneeId === "") {
				throw new NodeOperationError(
					ctx.getNode(),
					"An assignee is required when Assignee Type is set",
					{ itemIndex },
				);
			}
			const body = buildIssueUpdateBody({
				...fields,
				assigneeType,
				assigneeId,
			});
			if (Object.keys(body).length === 0) {
				throw new NodeOperationError(
					ctx.getNode(),
					"Nothing to update — add at least one field",
					{ itemIndex },
				);
			}
			return apiRequest(ctx, {
				method: "PATCH",
				path: `/issues/${keyParam()}`,
				body: body as IDataObject,
			});
		}
		case "triage":
			return apiRequest(ctx, {
				method: "POST",
				path: `/issues/${keyParam()}/triage`,
				body: {
					action: ctx.getNodeParameter("triageAction", itemIndex) as string,
				},
			});
		case "addComment":
			return apiRequest(ctx, {
				method: "POST",
				path: `/issues/${keyParam()}/comments`,
				body: {
					body: ctx.getNodeParameter("commentBody", itemIndex) as string,
				},
			});
		case "getComments":
			return extractList(
				await apiRequest(ctx, { path: `/issues/${keyParam()}/comments` }),
				"comments",
			);
		case "getEvents":
			return extractList(
				await apiRequest(ctx, { path: `/issues/${keyParam()}/events` }),
				"events",
			);
		default:
			throw new NodeOperationError(
				ctx.getNode(),
				`Unknown issue operation '${operation}'`,
			);
	}
}
