import { Composio } from "@composio/core";
import { mkdir } from "node:fs/promises";
import endpointCatalog from "./endpoints.json";

type ToolkitSlug = "gmail" | "googlecalendar";
type EndpointStatus = "valid" | "invalid_endpoint" | "insufficient_scopes" | "error";

type EndpointSpec = {
  toolkit: ToolkitSlug;
  tool_slug: string;
  description: string;
  method: string;
  path: string;
  required_scopes: string[];
  parameters: {
    query: Array<{ name: string; type: string; required: boolean; description: string }>;
    path: Array<{ name: string; type: string; required: boolean; description: string }>;
    body: null | {
      content_type: string;
      fields: Array<{ name: string; type: string; required: boolean; description: string }>;
    };
  };
};

type ConnectedAccount = {
  id: string;
  status: string;
  createdAt?: string;
  toolkit?: { slug?: string };
  state?: { val?: Record<string, unknown> };
  data?: Record<string, unknown>;
};

type ExecutionResult = {
  successful: boolean;
  data: unknown;
  error: unknown;
  logId?: string;
};

type ComposioExecutePayload = {
  actionName: string;
  connectedAccountId: string;
  input: Record<string, unknown>;
};

type ComposioWithExecute = Composio & {
  execute: (payload: ComposioExecutePayload) => Promise<ExecutionResult>;
};

type ToolDefinition = {
  function: {
    name: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
      required?: string[];
    };
  };
};

type EndpointIntent = {
  resource: "message" | "thread" | "label" | "profile" | "draft" | "event" | "calendar" | "reminder" | "unknown";
  operation: "list" | "get" | "create" | "send" | "trash" | "delete" | "archive" | "unknown";
  hasPathId: boolean;
  needsBody: boolean;
  destructive: boolean;
};

type ActionResolution = {
  actionName: string | null;
  confidence: number;
  exactMatch: boolean;
  reason: string;
  candidates: Array<{ actionName: string; score: number; reason: string }>;
};

type PlanningStep =
  | { kind: "resolve_self_email"; reason: string }
  | { kind: "resolve_message_id"; owned: boolean; reason: string }
  | { kind: "resolve_event_id"; owned: boolean; reason: string };

type ExecutionPlan = {
  resolvedActionName: string | null;
  actionResolution: string;
  actionCandidates: Array<{ actionName: string; score: number; reason: string }>;
  steps: PlanningStep[];
  arguments: Record<string, unknown>;
};

type EndpointReport = {
  toolkit: ToolkitSlug;
  toolSlug: string;
  resolvedActionName: string | null;
  method: string;
  path: string;
  status: EndpointStatus;
  httpStatus: number | null;
  responseSummary: string;
  errorMessage: string | null;
  requiredScopes: string[];
  availableScopes: string[];
  classificationReason: string;
  actionResolution: string;
  actionCandidates: Array<{ actionName: string; score: number; reason: string }>;
  planSteps: string[];
  logId: string | null;
};

type RunReport = {
  generatedAt: string;
  userId: string;
  accounts: Record<ToolkitSlug, { connectedAccountId: string | null; availableScopes: string[] }>;
  summary: Record<EndpointStatus, number>;
  results: EndpointReport[];
};

const USER_ID = "candidate";
const DEFAULT_OUTPUT = "reports/endpoint-test-report.json";
const RUN_ID = `run-${Date.now()}`;
const EVENT_TITLE = `[Endpoint Tester] ${RUN_ID} calendar fixture`;
const EMAIL_SUBJECT = `[Endpoint Tester] ${RUN_ID} mailbox fixture`;
const TIMEZONE = "UTC";

const endpoints: EndpointSpec[] = [
  ...endpointCatalog.gmail.endpoints.map((endpoint) => ({ ...endpoint, toolkit: "gmail" as const })),
  ...endpointCatalog.googlecalendar.endpoints.map((endpoint) => ({
    ...endpoint,
    toolkit: "googlecalendar" as const,
  })),
];

class EndpointTesterAgent {
  private composio: ComposioWithExecute;
  private accounts = new Map<ToolkitSlug, ConnectedAccount>();
  private toolCatalog = new Map<ToolkitSlug, ToolDefinition[]>();
  private actionLookup = new Map<string, ToolDefinition | null>();
  private selfEmail: string | null = null;
  private listedMessageId: string | null = null;
  private ownedMessageId: string | null = null;
  private listedEventId: string | null = null;
  private createdEventId: string | null = null;
  private eventDeleted = false;

  constructor(apiKey: string) {
    const composio = new Composio({ apiKey }) as ComposioWithExecute;

    // Normalize the installed SDK to the README's `composio.execute(...)` contract.
    if (typeof composio.execute !== "function") {
      composio.execute = async ({ actionName, connectedAccountId, input }) => {
        return (await composio.tools.execute(actionName, {
          userId: USER_ID,
          connectedAccountId,
          dangerouslySkipVersionCheck: true,
          arguments: input,
        })) as ExecutionResult;
      };
    }

    this.composio = composio;
  }

  async run(outputPath = DEFAULT_OUTPUT): Promise<RunReport> {
    await this.loadConnectedAccounts();
    await this.loadToolCatalogs();

    const results: EndpointReport[] = [];
    for (const endpoint of endpoints) {
      results.push(await this.testEndpoint(endpoint));
    }

    const report: RunReport = {
      generatedAt: new Date().toISOString(),
      userId: USER_ID,
      accounts: {
        gmail: {
          connectedAccountId: this.accounts.get("gmail")?.id ?? null,
          availableScopes: this.getAvailableScopes("gmail"),
        },
        googlecalendar: {
          connectedAccountId: this.accounts.get("googlecalendar")?.id ?? null,
          availableScopes: this.getAvailableScopes("googlecalendar"),
        },
      },
      summary: {
        valid: results.filter((item) => item.status === "valid").length,
        invalid_endpoint: results.filter((item) => item.status === "invalid_endpoint").length,
        insufficient_scopes: results.filter((item) => item.status === "insufficient_scopes").length,
        error: results.filter((item) => item.status === "error").length,
      },
      results,
    };

    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    this.printSummary(report, outputPath);
    return report;
  }

  private async loadConnectedAccounts() {
    const response = await this.composio.connectedAccounts.list({ userIds: [USER_ID] });
    const items = (response.items ?? []) as ConnectedAccount[];

    for (const toolkit of ["gmail", "googlecalendar"] as const) {
      const active = items
        .filter((item) => item.toolkit?.slug === toolkit && item.status === "ACTIVE")
        .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
      if (active[0]) {
        this.accounts.set(toolkit, active[0]);
      }
    }
  }

  private async loadToolCatalogs() {
    for (const toolkit of ["gmail", "googlecalendar"] as const) {
      try {
        const tools = (await this.composio.tools.get(USER_ID, {
          toolkits: [toolkit],
        })) as ToolDefinition[];
        this.toolCatalog.set(toolkit, tools);
      } catch {
        this.toolCatalog.set(toolkit, []);
      }
    }
  }

  private async testEndpoint(endpoint: EndpointSpec): Promise<EndpointReport> {
    const availableScopes = this.getAvailableScopes(endpoint.toolkit);
    const account = this.accounts.get(endpoint.toolkit);

    if (!account) {
      return this.buildReport(endpoint, null, "error", null, null, {
        responseSummary: "No active connected account available for toolkit",
        errorMessage: "connected_account_unavailable",
        classificationReason: "No active Composio connected account exists for this toolkit",
        actionResolution: "No connected account available, so the endpoint could not be tested",
        actionCandidates: [],
        planSteps: [],
        availableScopes,
      });
    }

    const resolution = await this.resolveAction(endpoint);
    if (!resolution.actionName) {
      return this.buildReport(endpoint, null, "invalid_endpoint", null, null, {
        responseSummary: "No matching Composio action exists for this endpoint",
        errorMessage: "tool_not_found",
        classificationReason: "The live Composio toolkit did not expose an action that matched the endpoint spec strongly enough",
        actionResolution: resolution.reason,
        actionCandidates: resolution.candidates,
        planSteps: [],
        availableScopes,
      });
    }

    const plan = await this.planEndpoint(endpoint, resolution);

    try {
      await this.executePlanningSteps(plan.steps);
      if (!plan.resolvedActionName) {
        throw new Error("No resolved action name available for endpoint execution");
      }
      const composedArguments = this.composeArguments(endpoint, plan.resolvedActionName, plan.arguments);
      const result = await this.composioExecute(endpoint.toolkit, plan.resolvedActionName, composedArguments);
      const status = this.classifyResult(result.error, result.successful);

      this.captureRuntimeState(endpoint.tool_slug, result.data);

      return this.buildReport(
        endpoint,
        plan.resolvedActionName,
        status,
        extractHttpStatus(result.error),
        result.logId ?? null,
        {
          responseSummary: summarizePayload(result.successful ? result.data : result.error),
          errorMessage: result.successful ? null : summarizePayload(result.error),
          classificationReason: this.explainClassification(status, result.error),
          actionResolution: plan.actionResolution,
          actionCandidates: plan.actionCandidates,
          planSteps: plan.steps.map(renderPlanningStep),
          availableScopes,
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = this.classifyErrorMessage(message, extractHttpStatus(error));
      return this.buildReport(endpoint, plan.resolvedActionName, status, extractHttpStatus(error), null, {
        responseSummary: message,
        errorMessage: message,
        classificationReason: this.explainClassification(status, error),
        actionResolution: plan.actionResolution,
        actionCandidates: plan.actionCandidates,
        planSteps: plan.steps.map(renderPlanningStep),
        availableScopes,
      });
    }
  }

  private async resolveAction(endpoint: EndpointSpec): Promise<ActionResolution> {
    const exact = await this.lookupAction(endpoint.tool_slug);
    if (exact) {
      return {
        actionName: exact.function.name,
        confidence: 1,
        exactMatch: true,
        reason: `Exact Composio action match found for ${endpoint.tool_slug}`,
        candidates: [{ actionName: exact.function.name, score: 1, reason: "Exact tool slug match" }],
      };
    }

    const generatedCandidates = generateCandidateActionNames(endpoint);
    const discovered: Array<{ actionName: string; score: number; reason: string }> = [];
    for (const candidateName of generatedCandidates) {
      const tool = await this.lookupAction(candidateName);
      if (tool) {
        discovered.push({
          actionName: tool.function.name,
          score: 10 - discovered.length,
          reason: "Generated from endpoint intent and confirmed against live Composio metadata",
        });
      }
    }
    if (discovered[0]) {
      return {
        actionName: discovered[0].actionName,
        confidence: discovered[0].score,
        exactMatch: false,
        reason: `Resolved ${endpoint.tool_slug} via runtime candidate generation from the endpoint method, path, and parameters`,
        candidates: discovered,
      };
    }

    return {
      actionName: null,
      confidence: 0,
      exactMatch: false,
      reason: `No runtime-generated candidate resolved to a live Composio action for ${endpoint.tool_slug}`,
      candidates: generatedCandidates.map((candidateName, index) => ({
        actionName: candidateName,
        score: Math.max(1, generatedCandidates.length - index),
        reason: "Candidate generated from endpoint intent but not found in the live toolkit",
      })),
    };
  }

  private async lookupAction(actionName: string): Promise<ToolDefinition | null> {
    if (this.actionLookup.has(actionName)) {
      return this.actionLookup.get(actionName) ?? null;
    }

    try {
      const tools = (await this.composio.tools.get(USER_ID, actionName)) as ToolDefinition[];
      const tool = tools[0] ?? null;
      this.actionLookup.set(actionName, tool);
      return tool;
    } catch {
      this.actionLookup.set(actionName, null);
      return null;
    }
  }

  private async planEndpoint(endpoint: EndpointSpec, resolution: ActionResolution): Promise<ExecutionPlan> {
    const actionName = resolution.actionName;
    if (!actionName) {
      return {
        resolvedActionName: null,
        actionResolution: resolution.reason,
        actionCandidates: resolution.candidates,
        steps: [],
        arguments: {},
      };
    }

    const tool = this.getToolDefinition(endpoint.toolkit, actionName);
    const intent = analyzeIntent(endpoint);
    const properties = tool?.function.parameters?.properties ?? {};
    const steps: PlanningStep[] = [];
    const seedArguments: Record<string, unknown> = {};

    if ("recipient_email" in properties) {
      steps.push({
        kind: "resolve_self_email",
        reason: "The action needs a recipient, so the agent first resolves the authenticated Gmail address",
      });
    }

    if ("message_id" in properties) {
      steps.push({
        kind: "resolve_message_id",
        owned: intent.destructive,
        reason: intent.destructive
          ? "The endpoint mutates a message, so the agent needs a run-owned message ID"
          : "The endpoint reads a specific message, so the agent first discovers a real message ID",
      });
    }

    if ("event_id" in properties) {
      steps.push({
        kind: "resolve_event_id",
        owned: intent.destructive,
        reason: intent.destructive
          ? "The endpoint deletes an event, so the agent needs a run-owned event ID"
          : "The endpoint reads a specific event, so the agent first discovers a real event ID",
      });
    }

    if ("calendar_id" in properties) {
      seedArguments.calendar_id = "primary";
    }

    if ("format" in properties) {
      seedArguments.format = "full";
    }

    if ("max_results" in properties) {
      seedArguments.max_results = 5;
    }

    if ("query" in properties) {
      seedArguments.query = intent.resource === "event" ? "" : "";
    }

    if ("q" in properties) {
      seedArguments.q = "";
    }

    if ("verbose" in properties) {
      seedArguments.verbose = false;
    }

    if ("single_events" in properties) {
      seedArguments.single_events = true;
    }

    if ("timeMin" in properties || "time_min" in properties) {
      seedArguments.timeMin = isoForGoogle(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    }

    if ("timeMax" in properties || "time_max" in properties) {
      seedArguments.timeMax = isoForGoogle(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
    }

    if ("start_datetime" in properties || "end_datetime" in properties || "timezone" in properties) {
      const window = buildUtcEventWindow();
      seedArguments.start_datetime = window.start;
      seedArguments.end_datetime = window.end;
      seedArguments.timezone = TIMEZONE;
      seedArguments.summary = EVENT_TITLE;
      seedArguments.description = `Temporary event created by the endpoint tester agent (${RUN_ID}).`;
      if ("send_updates" in properties) {
        seedArguments.send_updates = false;
      }
    }

    if ("subject" in properties) {
      seedArguments.subject =
        actionName.includes("DRAFT")
          ? `${EMAIL_SUBJECT} draft`
          : EMAIL_SUBJECT;
    }

    if ("body" in properties) {
      seedArguments.body = actionName.includes("DRAFT")
        ? `Draft generated by the endpoint tester agent at ${new Date().toISOString()}.`
        : `This email was generated by the endpoint tester agent at ${new Date().toISOString()}.`;
    }

    return {
      resolvedActionName: actionName,
      actionResolution: resolution.reason,
      actionCandidates: resolution.candidates,
      steps,
      arguments: seedArguments,
    };
  }

  private async executePlanningSteps(steps: PlanningStep[]) {
    for (const step of steps) {
      if (step.kind === "resolve_self_email") {
        await this.ensureSelfEmail();
      }
      if (step.kind === "resolve_message_id") {
        if (step.owned) {
          await this.ensureOwnedMessageId();
        } else {
          await this.ensureListedMessageId();
        }
      }
      if (step.kind === "resolve_event_id") {
        if (step.owned) {
          await this.ensureOwnedEventId();
        } else {
          await this.ensureListedEventId();
        }
      }
    }
  }

  private composeArguments(
    endpoint: EndpointSpec,
    actionName: string,
    seedArguments: Record<string, unknown>
  ): Record<string, unknown> {
    const tool = this.getToolDefinition(endpoint.toolkit, actionName);
    const properties = tool?.function.parameters?.properties ?? {};
    const arguments_: Record<string, unknown> = { ...seedArguments };

    if ("user_id" in properties) {
      arguments_.user_id = "me";
    }

    if ("recipient_email" in properties && this.selfEmail) {
      arguments_.recipient_email = this.selfEmail;
    }

    if ("message_id" in properties) {
      const intent = analyzeIntent(endpoint);
      arguments_.message_id = intent.destructive ? this.ownedMessageId : this.listedMessageId;
    }

    if ("event_id" in properties) {
      const intent = analyzeIntent(endpoint);
      arguments_.event_id = intent.destructive ? this.createdEventId : this.listedEventId;
    }

    if ("query" in properties && actionName.includes("GOOGLECALENDAR_FIND_EVENT")) {
      arguments_.query = "";
    }

    if ("timeMin" in properties) {
      arguments_.timeMin = isoForGoogle(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    }
    if ("timeMax" in properties) {
      arguments_.timeMax = isoForGoogle(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
    }

    return arguments_;
  }

  private getToolDefinition(toolkit: ToolkitSlug, actionName: string): ToolDefinition | undefined {
    return (this.toolCatalog.get(toolkit) ?? []).find((tool) => tool.function.name === actionName);
  }

  private async ensureSelfEmail(): Promise<string> {
    if (this.selfEmail) {
      return this.selfEmail;
    }

    const result = await this.composioExecute("gmail", "GMAIL_GET_PROFILE", {});
    if (!result.successful) {
      throw new Error(summarizePayload(result.error));
    }

    const email = getStringAtPath(result.data, ["emailAddress"]);
    if (!email) {
      throw new Error("Unable to resolve authenticated Gmail address from profile");
    }

    this.selfEmail = email;
    return email;
  }

  private async ensureListedMessageId(): Promise<string> {
    if (this.listedMessageId) {
      return this.listedMessageId;
    }

    const result = await this.composioExecute("gmail", "GMAIL_LIST_MESSAGES", {
      user_id: "me",
      max_results: 5,
    });
    if (!result.successful) {
      throw new Error(summarizePayload(result.error));
    }

    const messageId = findFirstId(result.data, ["messages"]);
    if (!messageId) {
      throw new Error("Unable to discover a real Gmail message ID from the list endpoint");
    }

    this.listedMessageId = messageId;
    return messageId;
  }

  private async ensureOwnedMessageId(): Promise<string> {
    if (this.ownedMessageId) {
      return this.ownedMessageId;
    }

    const recipient = await this.ensureSelfEmail();
    const sendResult = await this.composioExecute("gmail", "GMAIL_SEND_EMAIL", {
      user_id: "me",
      recipient_email: recipient,
      subject: EMAIL_SUBJECT,
      body: `This message was created for endpoint trash validation at ${new Date().toISOString()}.`,
    });
    if (!sendResult.successful) {
      throw new Error(summarizePayload(sendResult.error));
    }

    const sentId = findFirstStringByKey(sendResult.data, "id");
    if (sentId) {
      this.ownedMessageId = sentId;
      return sentId;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Bun.sleep(2000);
      const listResult = await this.composioExecute("gmail", "GMAIL_LIST_MESSAGES", {
        user_id: "me",
        q: `subject:"${EMAIL_SUBJECT}"`,
        max_results: 1,
      });
      if (!listResult.successful) {
        throw new Error(summarizePayload(listResult.error));
      }
      const messageId = findFirstId(listResult.data, ["messages"]);
      if (messageId) {
        this.ownedMessageId = messageId;
        return messageId;
      }
    }

    throw new Error("Unable to locate a run-owned Gmail message after sending it to self");
  }

  private async ensureListedEventId(): Promise<string> {
    if (this.listedEventId) {
      return this.listedEventId;
    }
    if (this.createdEventId && !this.eventDeleted) {
      return this.createdEventId;
    }

    const result = await this.composioExecute("googlecalendar", "GOOGLECALENDAR_FIND_EVENT", {
      calendar_id: "primary",
      query: "",
      max_results: 1,
      single_events: true,
      timeMin: isoForGoogle(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      timeMax: isoForGoogle(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
    });
    if (!result.successful) {
      throw new Error(summarizePayload(result.error));
    }

    const eventId = findFirstId(result.data, ["event_data", "items", "events"]);
    if (!eventId) {
      throw new Error("Unable to discover a real Calendar event ID from the list endpoint");
    }

    this.listedEventId = eventId;
    return eventId;
  }

  private async ensureOwnedEventId(): Promise<string> {
    if (this.createdEventId && !this.eventDeleted) {
      return this.createdEventId;
    }

    const { start, end } = buildUtcEventWindow();
    const createResult = await this.composioExecute("googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", {
      calendar_id: "primary",
      summary: EVENT_TITLE,
      description: `Temporary event created by the endpoint tester agent (${RUN_ID}).`,
      start_datetime: start,
      end_datetime: end,
      timezone: TIMEZONE,
      send_updates: false,
    });
    if (!createResult.successful) {
      throw new Error(summarizePayload(createResult.error));
    }

    const eventId =
      findFirstStringByKey(createResult.data, "event_id") ??
      findFirstStringByKey(createResult.data, "id");
    if (!eventId) {
      throw new Error("Unable to determine a run-owned Calendar event ID from create-event output");
    }

    this.createdEventId = eventId;
    this.eventDeleted = false;
    return eventId;
  }

  private async composioExecute(
    toolkit: ToolkitSlug,
    actionName: string,
    input: Record<string, unknown>
  ): Promise<ExecutionResult> {
    const account = this.accounts.get(toolkit);
    if (!account) {
      throw new Error(`No connected account for toolkit ${toolkit}`);
    }

    return await this.composio.execute({
      actionName,
      connectedAccountId: account.id,
      input,
    });
  }

  private classifyResult(error: unknown, successful: boolean): EndpointStatus {
    if (successful) {
      return "valid";
    }
    return this.classifyErrorMessage(summarizePayload(error), extractHttpStatus(error));
  }

  private classifyErrorMessage(message: string, httpStatus: number | null): EndpointStatus {
    const normalized = message.toLowerCase();
    if (
      httpStatus === 403 ||
      normalized.includes("forbidden") ||
      normalized.includes("insufficient") ||
      normalized.includes("permission") ||
      normalized.includes("scope")
    ) {
      return "insufficient_scopes";
    }
    if (
      httpStatus === 404 ||
      normalized.includes("not found") ||
      normalized.includes("tool_not_found") ||
      normalized.includes("does not exist")
    ) {
      return "invalid_endpoint";
    }
    return "error";
  }

  private explainClassification(status: EndpointStatus, value: unknown) {
    switch (status) {
      case "valid":
        return "Composio execution completed successfully";
      case "invalid_endpoint":
        return `The action or provider endpoint could not be found: ${summarizePayload(value)}`;
      case "insufficient_scopes":
        return `The provider reported a permission or scope failure: ${summarizePayload(value)}`;
      default:
        return `Unexpected execution failure: ${summarizePayload(value)}`;
    }
  }

  private getAvailableScopes(toolkit: ToolkitSlug): string[] {
    const account = this.accounts.get(toolkit);
    const scopeValue = getStringByKey(account?.state?.val ?? account?.data ?? {}, "scope");
    return scopeValue ? scopeValue.split(/\s+/).filter(Boolean) : [];
  }

  private captureRuntimeState(toolSlug: string, data: unknown) {
    if (toolSlug === "GMAIL_GET_PROFILE") {
      const email = getStringAtPath(data, ["emailAddress"]);
      if (email) {
        this.selfEmail = email;
      }
    }

    if (toolSlug === "GMAIL_LIST_MESSAGES") {
      const messageId = findFirstId(data, ["messages"]);
      if (messageId) {
        this.listedMessageId = messageId;
      }
    }

    if (toolSlug === "GMAIL_SEND_MESSAGE") {
      const messageId = findFirstStringByKey(data, "id");
      if (messageId) {
        this.ownedMessageId = messageId;
      }
    }

    if (toolSlug === "GOOGLECALENDAR_CREATE_EVENT") {
      const eventId = findFirstStringByKey(data, "event_id") ?? findFirstStringByKey(data, "id");
      if (eventId) {
        this.createdEventId = eventId;
        this.eventDeleted = false;
      }
    }

    if (toolSlug === "GOOGLECALENDAR_LIST_EVENTS") {
      const eventId = findFirstId(data, ["event_data", "items", "events"]);
      if (eventId) {
        this.listedEventId = eventId;
      }
    }

    if (toolSlug === "GOOGLECALENDAR_DELETE_EVENT") {
      this.eventDeleted = true;
    }
  }

  private buildReport(
    endpoint: EndpointSpec,
    resolvedActionName: string | null,
    status: EndpointStatus,
    httpStatus: number | null,
    logId: string | null,
    details: {
      responseSummary: string;
      errorMessage: string | null;
      classificationReason: string;
      actionResolution: string;
      actionCandidates: Array<{ actionName: string; score: number; reason: string }>;
      planSteps: string[];
      availableScopes: string[];
    }
  ): EndpointReport {
    return {
      toolkit: endpoint.toolkit,
      toolSlug: endpoint.tool_slug,
      resolvedActionName,
      method: endpoint.method,
      path: endpoint.path,
      status,
      httpStatus,
      responseSummary: details.responseSummary,
      errorMessage: details.errorMessage,
      requiredScopes: endpoint.required_scopes,
      availableScopes: details.availableScopes,
      classificationReason: details.classificationReason,
      actionResolution: details.actionResolution,
      actionCandidates: details.actionCandidates,
      planSteps: details.planSteps,
      logId,
    };
  }

  private printSummary(report: RunReport, outputPath: string) {
    console.log("\n=== Endpoint Tester Report ===");
    console.log(`Output: ${outputPath}`);
    console.log(`Valid: ${report.summary.valid}`);
    console.log(`Invalid endpoint: ${report.summary.invalid_endpoint}`);
    console.log(`Insufficient scopes: ${report.summary.insufficient_scopes}`);
    console.log(`Error: ${report.summary.error}\n`);

    for (const result of report.results) {
      console.log(
        `${result.status.padEnd(20)} ${result.toolSlug.padEnd(30)} ${result.responseSummary.slice(0, 100)}`
      );
    }
  }
}

function analyzeIntent(endpoint: EndpointSpec): EndpointIntent {
  const path = endpoint.path.toLowerCase();
  const hasPathId = endpoint.parameters.path.length > 0;

  const resource: EndpointIntent["resource"] = path.includes("/messages")
    ? "message"
    : path.includes("/threads")
      ? "thread"
      : path.includes("/labels")
        ? "label"
        : path.includes("/profile")
          ? "profile"
          : path.includes("/drafts")
            ? "draft"
            : path.includes("/events")
              ? "event"
              : path.includes("calendarlist")
                ? "calendar"
                : path.includes("/reminders")
                  ? "reminder"
                  : "unknown";

  let operation: EndpointIntent["operation"] = "unknown";
  if (endpoint.method === "GET" && !hasPathId) operation = "list";
  if (endpoint.method === "GET" && hasPathId) operation = "get";
  if (endpoint.method === "DELETE") operation = "delete";
  if (endpoint.method === "POST" && path.endsWith("/send")) operation = "send";
  if (endpoint.method === "POST" && path.endsWith("/trash")) operation = "trash";
  if (endpoint.method === "POST" && path.endsWith("/archive")) operation = "archive";
  if (endpoint.method === "POST" && operation === "unknown") operation = "create";

  return {
    resource,
    operation,
    hasPathId,
    needsBody: endpoint.parameters.body !== null,
    destructive: operation === "trash" || operation === "delete" || operation === "archive",
  };
}

function scoreCandidate(endpoint: EndpointSpec, intent: EndpointIntent, tool: ToolDefinition) {
  const name = tool.function.name;
  const tokens = tokenize(name);
  let score = 0;
  const reasons: string[] = [];

  const resourceTokens: Record<EndpointIntent["resource"], string[]> = {
    message: ["message", "messages", "email", "emails"],
    thread: ["thread", "threads"],
    label: ["label", "labels"],
    profile: ["profile"],
    draft: ["draft", "drafts"],
    event: ["event", "events"],
    calendar: ["calendar", "calendars"],
    reminder: ["reminder", "reminders"],
    unknown: [],
  };

  const operationTokens: Record<EndpointIntent["operation"], string[]> = {
    list: ["list", "find"],
    get: ["get", "fetch"],
    create: ["create", "insert"],
    send: ["send"],
    trash: ["trash"],
    delete: ["delete"],
    archive: ["archive"],
    unknown: [],
  };

  const matchingResource = resourceTokens[intent.resource].filter((token) => tokens.has(token));
  if (matchingResource.length > 0) {
    score += 3;
    reasons.push(`resource match: ${matchingResource.join(", ")}`);
  } else if (intent.resource !== "unknown") {
    score -= 2;
  }

  const matchingOperation = operationTokens[intent.operation].filter((token) => tokens.has(token));
  if (matchingOperation.length > 0) {
    score += 4;
    reasons.push(`operation match: ${matchingOperation.join(", ")}`);
  } else if (intent.operation !== "unknown") {
    score -= 1;
  }

  if (intent.hasPathId && toolRequiresIdentifier(tool)) {
    score += 2;
    reasons.push("identifier requirement aligns");
  }

  if (intent.needsBody && toolAcceptsBody(tool)) {
    score += 1;
    reasons.push("body-capable action");
  }

  const slugTokenOverlap = intersectSets(tokenize(endpoint.tool_slug), tokens);
  if (slugTokenOverlap.length > 0) {
    score += Math.min(3, slugTokenOverlap.length);
    reasons.push(`slug overlap: ${slugTokenOverlap.join(", ")}`);
  }

  const descriptionOverlap = intersectSets(tokenize(endpoint.description), tokens);
  if (descriptionOverlap.length > 0) {
    score += 1;
    reasons.push(`description overlap: ${descriptionOverlap.join(", ")}`);
  }

  return {
    tool,
    score,
    reason: reasons.join("; ") || "weak match",
  };
}

function generateCandidateActionNames(endpoint: EndpointSpec) {
  const intent = analyzeIntent(endpoint);
  const prefix = endpoint.toolkit === "gmail" ? "GMAIL" : "GOOGLECALENDAR";
  const resourceVariants: Record<EndpointIntent["resource"], string[]> = {
    message: ["MESSAGE", "EMAIL"],
    thread: ["THREAD"],
    label: ["LABEL"],
    profile: ["PROFILE"],
    draft: ["DRAFT", "EMAIL_DRAFT"],
    event: ["EVENT", "EVENTS"],
    calendar: ["CALENDAR", "CALENDARS", "CALENDAR_LIST"],
    reminder: ["REMINDER", "REMINDERS"],
    unknown: [],
  };
  const operationVariants: Record<EndpointIntent["operation"], string[]> = {
    list: ["LIST", "FIND"],
    get: ["GET", "FETCH"],
    create: ["CREATE", "INSERT"],
    send: ["SEND"],
    trash: ["MOVE_TO_TRASH", "TRASH"],
    delete: ["DELETE"],
    archive: ["ARCHIVE"],
    unknown: [],
  };

  const candidates = new Set<string>();
  candidates.add(endpoint.tool_slug);

  for (const operation of operationVariants[intent.operation]) {
    for (const resource of resourceVariants[intent.resource]) {
      candidates.add(`${prefix}_${operation}_${resource}`);
      candidates.add(`${prefix}_${resource}_${operation}`);
    }
  }

  if (endpoint.toolkit === "gmail" && intent.resource === "message" && intent.operation === "get" && intent.hasPathId) {
    candidates.add("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
  }
  if (endpoint.toolkit === "gmail" && intent.resource === "draft" && intent.operation === "create") {
    candidates.add("GMAIL_CREATE_EMAIL_DRAFT");
  }
  if (endpoint.toolkit === "gmail" && intent.resource === "message" && intent.operation === "send") {
    candidates.add("GMAIL_SEND_EMAIL");
  }
  if (endpoint.toolkit === "gmail" && intent.resource === "message" && intent.operation === "trash") {
    candidates.add("GMAIL_MOVE_TO_TRASH");
  }
  if (endpoint.toolkit === "googlecalendar" && intent.resource === "event" && intent.operation === "get") {
    candidates.add("GOOGLECALENDAR_EVENTS_GET");
  }
  if (endpoint.toolkit === "googlecalendar" && intent.resource === "event" && intent.operation === "list") {
    candidates.add("GOOGLECALENDAR_FIND_EVENT");
    candidates.add("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS");
  }
  if (endpoint.toolkit === "googlecalendar" && intent.resource === "calendar" && intent.operation === "list") {
    candidates.add("GOOGLECALENDAR_LIST_CALENDARS");
  }

  return [...candidates];
}

function toolRequiresIdentifier(tool: ToolDefinition) {
  const properties = tool.function.parameters?.properties ?? {};
  return "message_id" in properties || "event_id" in properties;
}

function toolAcceptsBody(tool: ToolDefinition) {
  const properties = tool.function.parameters?.properties ?? {};
  return (
    "body" in properties ||
    "subject" in properties ||
    "start_datetime" in properties ||
    "summary" in properties
  );
}

function tokenize(value: string) {
  return new Set(
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function intersectSets(left: Set<string>, right: Set<string>) {
  return [...left].filter((token) => right.has(token));
}

function renderPlanningStep(step: PlanningStep) {
  if (step.kind === "resolve_self_email") {
    return step.reason;
  }
  if (step.kind === "resolve_message_id") {
    return `${step.reason}${step.owned ? " (owned fixture)" : " (existing fixture)"}`;
  }
  return `${step.reason}${step.owned ? " (owned fixture)" : " (existing fixture)"}`;
}

function buildUtcEventWindow() {
  const startDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
  startDate.setUTCMinutes(0, 0, 0);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
  return {
    start: startDate.toISOString().slice(0, 19),
    end: endDate.toISOString().slice(0, 19),
  };
}

function isoForGoogle(date: Date) {
  return date.toISOString();
}

function summarizePayload(value: unknown, maxLength = 220): string {
  if (value == null) {
    return "No response payload";
  }
  if (typeof value === "string") {
    return value.slice(0, maxLength);
  }
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function extractHttpStatus(value: unknown): number | null {
  const candidates = [
    getNumberByKey(value, "status"),
    getNumberByKey(value, "statusCode"),
    getNumberByKey(value, "code"),
  ].filter((candidate): candidate is number => typeof candidate === "number");
  return candidates.find((candidate) => candidate >= 100 && candidate <= 599) ?? null;
}

function getStringAtPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

function getStringByKey(value: unknown, wantedKey: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getStringByKey(item, wantedKey);
      if (nested) return nested;
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "string") {
      return nestedValue;
    }
    const nested = getStringByKey(nestedValue, wantedKey);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function getNumberByKey(value: unknown, wantedKey: string): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getNumberByKey(item, wantedKey);
      if (nested != null) return nested;
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "number") {
      return nestedValue;
    }
    const nested = getNumberByKey(nestedValue, wantedKey);
    if (nested != null) {
      return nested;
    }
  }
  return null;
}

function findFirstId(value: unknown, preferredKeys: string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstId(item, preferredKeys);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    const candidate = record[key];
    if (candidate) {
      const found = findFirstId(candidate, preferredKeys);
      if (found) {
        return found;
      }
    }
  }

  if (typeof record.id === "string") return record.id;
  if (typeof record.message_id === "string") return record.message_id;
  if (typeof record.event_id === "string") return record.event_id;

  for (const nested of Object.values(record)) {
    const found = findFirstId(nested, preferredKeys);
    if (found) {
      return found;
    }
  }
  return null;
}

function findFirstStringByKey(value: unknown, wantedKey: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, wantedKey);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof nestedValue === "string") {
      return nestedValue;
    }
    const found = findFirstStringByKey(nestedValue, wantedKey);
    if (found) {
      return found;
    }
  }
  return null;
}

function getOutputPath() {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0 && process.argv[outIndex + 1]) {
    return process.argv[outIndex + 1];
  }
  return DEFAULT_OUTPUT;
}

async function main() {
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is required. Run setup.sh or export the key before executing the agent.");
  }

  await mkdir("reports", { recursive: true });
  const agent = new EndpointTesterAgent(process.env.COMPOSIO_API_KEY);
  await agent.run(getOutputPath());
}

await main();
