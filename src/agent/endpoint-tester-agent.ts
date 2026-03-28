import { dirname, join } from "node:path";
import { ENDPOINTS, RUN_CONTEXT, TOOLKITS } from "../config/constants";
import { DEFAULT_DASHBOARD_OUTPUT, MAX_RETRIES, PER_TOOLKIT_COOLDOWN_MS, TOOLKIT_CONCURRENCY } from "../config/constants";
import { createComposioClient } from "../lib/composio-client";
import { analyzeIntent, buildUtcEventWindow, generateCandidateActionNames, isoForGoogle, renderPlanningStep } from "../utils/endpoint-helpers";
import { buildEndpointReport, buildSummary, classifyErrorMessage, classifyResult, explainClassification, printReportSummary } from "../utils/reporting";
import { buildScopeSuggestions } from "../utils/scope-suggestions";
import { writeDashboard } from "../utils/dashboard";
import type {
  ActionCandidate,
  ActionResolution,
  ComposioWithExecute,
  ConnectedAccount,
  ExecutionPlan,
  EndpointReport,
  EndpointSpec,
  RunContext,
  RunReport,
  ToolkitSlug,
  ToolDefinition,
} from "../types";
import { extractHttpStatus, findFirstId, findFirstStringByKey, getStringAtPath, getStringByKey, serializePayload, summarizePayload } from "../utils/value-utils";

export class EndpointTesterAgent {
  private readonly composio: ComposioWithExecute;
  private readonly accounts = new Map<ToolkitSlug, ConnectedAccount>();
  private readonly toolCatalog = new Map<ToolkitSlug, ToolDefinition[]>();
  private readonly actionLookup = new Map<string, ToolDefinition | null>();
  private readonly lastExecutionAt = new Map<ToolkitSlug, number>();

  private selfEmail: string | null = null;
  private listedMessageId: string | null = null;
  private ownedMessageId: string | null = null;
  private listedEventId: string | null = null;
  private createdEventId: string | null = null;
  private eventDeleted = false;

  constructor(
    apiKey: string,
    private readonly runContext: RunContext = RUN_CONTEXT
  ) {
    this.composio = createComposioClient(apiKey);
  }

  async run(outputPath: string): Promise<RunReport> {
    await this.loadConnectedAccounts();
    await this.loadToolCatalogs();

    const toolkitResults = await Promise.all(
      TOOLKITS.map(async (toolkit) => ({
        toolkit,
        results: await this.runToolkitEndpoints(toolkit),
      }))
    );
    const resultLookup = new Map(
      toolkitResults.flatMap((entry) => entry.results.map((result) => [result.toolSlug, result] as const))
    );
    const results = ENDPOINTS.map((endpoint) => resultLookup.get(endpoint.tool_slug)).filter(
      (result): result is EndpointReport => result !== undefined
    );

    const report: RunReport = {
      generatedAt: new Date().toISOString(),
      userId: this.runContext.userId,
      execution: {
        mode: "toolkit_parallel",
        toolkitConcurrency: TOOLKIT_CONCURRENCY,
        perToolkitCooldownMs: PER_TOOLKIT_COOLDOWN_MS,
        maxRetries: MAX_RETRIES,
      },
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
      summary: buildSummary(results),
      results,
    };

    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    await writeDashboard(report, this.getDashboardOutputPath(outputPath));
    printReportSummary(report, outputPath);
    return report;
  }

  private async runToolkitEndpoints(toolkit: ToolkitSlug): Promise<EndpointReport[]> {
    const endpoints = ENDPOINTS.filter((endpoint) => endpoint.toolkit === toolkit);
    const results: EndpointReport[] = [];

    for (const endpoint of endpoints) {
      results.push(await this.testEndpoint(endpoint));
    }

    return results;
  }

  private async loadConnectedAccounts(): Promise<void> {
    const response = await this.composio.connectedAccounts.list({ userIds: [this.runContext.userId] });
    const items = (response.items ?? []) as ConnectedAccount[];

    for (const toolkit of TOOLKITS) {
      const active = items
        .filter((item) => item.toolkit?.slug === toolkit && item.status === "ACTIVE")
        .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));

      if (active[0]) {
        this.accounts.set(toolkit, active[0]);
      }
    }
  }

  private async loadToolCatalogs(): Promise<void> {
    for (const toolkit of TOOLKITS) {
      try {
        const tools = (await this.composio.tools.get(this.runContext.userId, {
          toolkits: [toolkit],
        })) as ToolDefinition[];
        this.toolCatalog.set(toolkit, tools);
      } catch {
        this.toolCatalog.set(toolkit, []);
      }
    }
  }

  private async testEndpoint(endpoint: EndpointSpec): Promise<EndpointReport> {
    const startedAt = performance.now();
    const availableScopes = this.getAvailableScopes(endpoint.toolkit);
    const account = this.accounts.get(endpoint.toolkit);

    if (!account) {
      return buildEndpointReport(endpoint, null, "error", null, null, {
        responseSummary: "No active connected account available for toolkit",
        errorMessage: "connected_account_unavailable",
        classificationReason: "No active Composio connected account exists for this toolkit",
        actionResolution: "No connected account available, so the endpoint could not be tested",
        actionCandidates: [],
        planSteps: [],
        availableScopes,
        attemptCount: 0,
        executionMs: Math.round(performance.now() - startedAt),
        scopeSuggestions: [],
      });
    }

    const resolution = await this.resolveAction(endpoint);
    if (!resolution.actionName) {
      return buildEndpointReport(endpoint, null, "invalid_endpoint", null, null, {
        responseSummary: "No matching Composio action exists for this endpoint",
        errorMessage: "tool_not_found",
        classificationReason: "The live Composio toolkit did not expose an action that matched the endpoint spec strongly enough",
        actionResolution: resolution.reason,
        actionCandidates: resolution.candidates,
        planSteps: [],
        availableScopes,
        attemptCount: 0,
        executionMs: Math.round(performance.now() - startedAt),
        scopeSuggestions: [],
      });
    }

    const plan = this.planEndpoint(endpoint, resolution);

    try {
      await this.executePlanningSteps(plan.steps);

      if (!plan.resolvedActionName) {
        throw new Error("No resolved action name available for endpoint execution");
      }

      const input = this.composeArguments(endpoint, plan.resolvedActionName, plan.arguments);
      const execution = await this.composioExecuteDetailed(endpoint.toolkit, plan.resolvedActionName, input);
      const result = execution.result;
      const status = classifyResult(result.error, result.successful);
      const scopeSuggestions =
        status === "insufficient_scopes" ? buildScopeSuggestions(endpoint, availableScopes) : [];

      this.captureRuntimeState(endpoint.tool_slug, result.data);

      return buildEndpointReport(
        endpoint,
        plan.resolvedActionName,
        status,
        extractHttpStatus(result.error),
        result.logId ?? null,
        {
          responseSummary: summarizePayload(result.successful ? result.data : result.error),
          errorMessage: result.successful ? null : summarizePayload(result.error),
          classificationReason: explainClassification(status, result.error),
          actionResolution: plan.actionResolution,
          actionCandidates: plan.actionCandidates,
          planSteps: plan.steps.map(renderPlanningStep),
          availableScopes,
          attemptCount: execution.attemptCount,
          executionMs: Math.round(performance.now() - startedAt),
          scopeSuggestions,
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const httpStatus = extractHttpStatus(error) ?? extractHttpStatus(message);
      const status = classifyErrorMessage(message, httpStatus);
      const scopeSuggestions =
        status === "insufficient_scopes" ? buildScopeSuggestions(endpoint, availableScopes) : [];

      return buildEndpointReport(endpoint, plan.resolvedActionName, status, httpStatus, null, {
        responseSummary: message,
        errorMessage: message,
        classificationReason: explainClassification(status, error),
        actionResolution: plan.actionResolution,
        actionCandidates: plan.actionCandidates,
        planSteps: plan.steps.map(renderPlanningStep),
        availableScopes,
        attemptCount: 1,
        executionMs: Math.round(performance.now() - startedAt),
        scopeSuggestions,
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
    const discovered = await Promise.all(
      generatedCandidates.map(async (candidateName, index) => {
        const tool = await this.lookupAction(candidateName);
        if (!tool) {
          return null;
        }

        return {
          actionName: tool.function.name,
          score: 10 - index,
          reason: "Generated from endpoint intent and confirmed against live Composio metadata",
        } satisfies ActionCandidate;
      })
    );

    const matchingCandidates = dedupeCandidates(
      discovered.filter((candidate): candidate is ActionCandidate => candidate !== null)
    );
    if (matchingCandidates[0]) {
      return {
        actionName: matchingCandidates[0].actionName,
        confidence: matchingCandidates[0].score,
        exactMatch: false,
        reason: `Resolved ${endpoint.tool_slug} via runtime candidate generation from the endpoint method, path, and parameters`,
        candidates: matchingCandidates,
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
      const tools = (await this.composio.tools.get(this.runContext.userId, actionName)) as ToolDefinition[];
      const tool = tools[0] ?? null;
      this.actionLookup.set(actionName, tool);
      return tool;
    } catch {
      this.actionLookup.set(actionName, null);
      return null;
    }
  }

  private planEndpoint(endpoint: EndpointSpec, resolution: ActionResolution): ExecutionPlan {
    if (!resolution.actionName) {
      return {
        resolvedActionName: null,
        actionResolution: resolution.reason,
        actionCandidates: resolution.candidates,
        steps: [],
        arguments: {},
      };
    }

    const tool = this.getToolDefinition(endpoint.toolkit, resolution.actionName);
    const properties = tool?.function.parameters?.properties ?? {};
    const intent = analyzeIntent(endpoint);

    return {
      resolvedActionName: resolution.actionName,
      actionResolution: resolution.reason,
      actionCandidates: resolution.candidates,
      steps: this.buildPlanningSteps(intent.destructive, properties),
      arguments: this.buildSeedArguments(resolution.actionName, properties),
    };
  }

  private buildPlanningSteps(
    isDestructive: boolean,
    properties: Record<string, unknown>
  ): ExecutionPlan["steps"] {
    const steps: ExecutionPlan["steps"] = [];

    if ("recipient_email" in properties) {
      steps.push({
        kind: "resolve_self_email",
        reason: "The action needs a recipient, so the agent first resolves the authenticated Gmail address",
      });
    }

    if ("message_id" in properties) {
      steps.push({
        kind: "resolve_message_id",
        owned: isDestructive,
        reason: isDestructive
          ? "The endpoint mutates a message, so the agent needs a run-owned message ID"
          : "The endpoint reads a specific message, so the agent first discovers a real message ID",
      });
    }

    if ("event_id" in properties) {
      steps.push({
        kind: "resolve_event_id",
        owned: isDestructive,
        reason: isDestructive
          ? "The endpoint deletes an event, so the agent needs a run-owned event ID"
          : "The endpoint reads a specific event, so the agent first discovers a real event ID",
      });
    }

    return steps;
  }

  private buildSeedArguments(
    actionName: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    const seedArguments: Record<string, unknown> = {};

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
      seedArguments.query = "";
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
      seedArguments.timezone = this.runContext.timezone;
      seedArguments.summary = this.runContext.eventTitle;
      seedArguments.description = `Temporary event created by the endpoint tester agent (${this.runContext.runId}).`;

      if ("send_updates" in properties) {
        seedArguments.send_updates = false;
      }
    }

    if ("subject" in properties) {
      seedArguments.subject = actionName.includes("DRAFT")
        ? `${this.runContext.emailSubject} draft`
        : this.runContext.emailSubject;
    }

    if ("body" in properties) {
      seedArguments.body = actionName.includes("DRAFT")
        ? `Draft generated by the endpoint tester agent at ${new Date().toISOString()}.`
        : `This email was generated by the endpoint tester agent at ${new Date().toISOString()}.`;
    }

    return seedArguments;
  }

  private async executePlanningSteps(steps: ExecutionPlan["steps"]): Promise<void> {
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
    const intent = analyzeIntent(endpoint);

    if ("user_id" in properties) {
      arguments_.user_id = "me";
    }

    if ("recipient_email" in properties && this.selfEmail) {
      arguments_.recipient_email = this.selfEmail;
    }

    if ("message_id" in properties) {
      arguments_.message_id = intent.destructive ? this.ownedMessageId : this.listedMessageId;
    }

    if ("event_id" in properties) {
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
      throw new Error(serializePayload(result.error));
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
      throw new Error(serializePayload(result.error));
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
      subject: this.runContext.emailSubject,
      body: `This message was created for endpoint trash validation at ${new Date().toISOString()}.`,
    });
    if (!sendResult.successful) {
      throw new Error(serializePayload(sendResult.error));
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
        q: `subject:"${this.runContext.emailSubject}"`,
        max_results: 1,
      });
      if (!listResult.successful) {
        throw new Error(serializePayload(listResult.error));
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
      throw new Error(serializePayload(result.error));
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
      summary: this.runContext.eventTitle,
      description: `Temporary event created by the endpoint tester agent (${this.runContext.runId}).`,
      start_datetime: start,
      end_datetime: end,
      timezone: this.runContext.timezone,
      send_updates: false,
    });
    if (!createResult.successful) {
      throw new Error(serializePayload(createResult.error));
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
  ) {
    const execution = await this.composioExecuteDetailed(toolkit, actionName, input);
    return execution.result;
  }

  private async composioExecuteDetailed(
    toolkit: ToolkitSlug,
    actionName: string,
    input: Record<string, unknown>
  ): Promise<{ result: Awaited<ReturnType<ComposioWithExecute["execute"]>>; attemptCount: number }> {
    const account = this.accounts.get(toolkit);
    if (!account) {
      throw new Error(`No connected account for toolkit ${toolkit}`);
    }

    let attemptCount = 0;
    let lastResult: Awaited<ReturnType<ComposioWithExecute["execute"]>> | null = null;
    let lastError: unknown = null;

    while (attemptCount <= MAX_RETRIES) {
      attemptCount += 1;
      await this.waitForToolkitSlot(toolkit);

      try {
        const result = await this.composio.execute({
          actionName,
          connectedAccountId: account.id,
          input,
        });
        lastResult = result;

        if (!shouldRetryResult(result) || attemptCount > MAX_RETRIES) {
          return { result, attemptCount };
        }
      } catch (error) {
        lastError = error;
        if (!isTransientFailure(error) || attemptCount > MAX_RETRIES) {
          throw error;
        }
      }

      await Bun.sleep(getRetryDelayMs(attemptCount));
    }

    if (lastResult) {
      return { result: lastResult, attemptCount };
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async waitForToolkitSlot(toolkit: ToolkitSlug): Promise<void> {
    const lastExecutionAt = this.lastExecutionAt.get(toolkit);
    if (typeof lastExecutionAt === "number") {
      const elapsed = Date.now() - lastExecutionAt;
      const waitMs = PER_TOOLKIT_COOLDOWN_MS - elapsed;
      if (waitMs > 0) {
        await Bun.sleep(waitMs);
      }
    }

    this.lastExecutionAt.set(toolkit, Date.now());
  }

  private getAvailableScopes(toolkit: ToolkitSlug): string[] {
    const account = this.accounts.get(toolkit);
    const scopeValue = getStringByKey(account?.state?.val ?? account?.data ?? {}, "scope");
    return scopeValue ? scopeValue.split(/\s+/).filter(Boolean) : [];
  }

  private captureRuntimeState(toolSlug: string, data: unknown): void {
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

  private getDashboardOutputPath(reportOutputPath: string): string {
    if (!reportOutputPath.includes("/")) {
      return DEFAULT_DASHBOARD_OUTPUT;
    }

    return join(dirname(reportOutputPath), "dashboard.html");
  }
}

function dedupeCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
  const uniqueCandidates = new Map<string, ActionCandidate>();

  for (const candidate of candidates) {
    const existing = uniqueCandidates.get(candidate.actionName);
    if (!existing || candidate.score > existing.score) {
      uniqueCandidates.set(candidate.actionName, candidate);
    }
  }

  return [...uniqueCandidates.values()].sort((left, right) => right.score - left.score);
}

function shouldRetryResult(result: Awaited<ReturnType<ComposioWithExecute["execute"]>>): boolean {
  if (result.successful) {
    return false;
  }

  return isTransientFailure(result.error);
}

function isTransientFailure(error: unknown): boolean {
  const httpStatus = extractHttpStatus(error);
  const message = summarizePayload(error).toLowerCase();

  if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429) {
    return true;
  }

  if (typeof httpStatus === "number" && httpStatus >= 500 && httpStatus <= 599) {
    return true;
  }

  return (
    message.includes("rate limit") ||
    message.includes("temporar") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("service unavailable")
  );
}

function getRetryDelayMs(attemptCount: number): number {
  return 400 * 2 ** (attemptCount - 1);
}
