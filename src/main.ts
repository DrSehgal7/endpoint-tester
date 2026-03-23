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
  dependencyStrategy: string | null;
  dependencySource: string | null;
  classificationReason: string;
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
const ACTION_MAP: Record<string, string | null> = {
  GMAIL_GET_MESSAGE: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  GMAIL_SEND_MESSAGE: "GMAIL_SEND_EMAIL",
  GMAIL_CREATE_DRAFT: "GMAIL_CREATE_EMAIL_DRAFT",
  GMAIL_TRASH_MESSAGE: "GMAIL_MOVE_TO_TRASH",
  GMAIL_LIST_FOLDERS: null,
  GMAIL_ARCHIVE_MESSAGE: null,
  GOOGLECALENDAR_LIST_EVENTS: "GOOGLECALENDAR_FIND_EVENT",
  GOOGLECALENDAR_GET_EVENT: "GOOGLECALENDAR_EVENTS_GET",
  GOOGLECALENDAR_LIST_REMINDERS: null,
};

const ENDPOINT_ORDER = [
  "GMAIL_GET_PROFILE",
  "GMAIL_LIST_MESSAGES",
  "GMAIL_GET_MESSAGE",
  "GMAIL_SEND_MESSAGE",
  "GMAIL_LIST_LABELS",
  "GMAIL_CREATE_DRAFT",
  "GMAIL_LIST_THREADS",
  "GMAIL_TRASH_MESSAGE",
  "GMAIL_LIST_FOLDERS",
  "GMAIL_ARCHIVE_MESSAGE",
  "GOOGLECALENDAR_LIST_CALENDARS",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_LIST_EVENTS",
  "GOOGLECALENDAR_GET_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_LIST_REMINDERS",
] as const;

const endpoints: EndpointSpec[] = [
  ...endpointCatalog.gmail.endpoints.map((endpoint) => ({ ...endpoint, toolkit: "gmail" as const })),
  ...endpointCatalog.googlecalendar.endpoints.map((endpoint) => ({
    ...endpoint,
    toolkit: "googlecalendar" as const,
  })),
].sort((a, b) => ENDPOINT_ORDER.indexOf(a.tool_slug as never) - ENDPOINT_ORDER.indexOf(b.tool_slug as never));

class EndpointTesterAgent {
  private composio: Composio;
  private actionCache = new Map<string, boolean>();
  private accounts = new Map<ToolkitSlug, ConnectedAccount>();
  private selfEmail: string | null = null;
  private listedMessageId: string | null = null;
  private ownedMessageId: string | null = null;
  private listedEventId: string | null = null;
  private createdEventId: string | null = null;
  private eventDeleted = false;

  constructor(apiKey: string) {
    this.composio = new Composio({ apiKey });
  }

  async run(outputPath = DEFAULT_OUTPUT): Promise<RunReport> {
    await this.loadAccounts();

    const results: EndpointReport[] = [];
    for (const endpoint of endpoints) {
      results.push(await this.testEndpoint(endpoint));
    }

    const summary: RunReport["summary"] = {
      valid: results.filter((item) => item.status === "valid").length,
      invalid_endpoint: results.filter((item) => item.status === "invalid_endpoint").length,
      insufficient_scopes: results.filter((item) => item.status === "insufficient_scopes").length,
      error: results.filter((item) => item.status === "error").length,
    };

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
      summary,
      results,
    };

    await Bun.write(outputPath, JSON.stringify(report, null, 2));
    this.printSummary(report, outputPath);
    return report;
  }

  private async loadAccounts() {
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

  private async testEndpoint(endpoint: EndpointSpec): Promise<EndpointReport> {
    const availableScopes = this.getAvailableScopes(endpoint.toolkit);
    const account = this.accounts.get(endpoint.toolkit);
    const resolvedActionName = await this.resolveActionName(endpoint.tool_slug);

    if (!account) {
      return this.buildReport(endpoint, resolvedActionName, "error", null, null, {
        responseSummary: "No active connected account available for toolkit",
        errorMessage: "connected_account_unavailable",
        dependencyStrategy: null,
        dependencySource: null,
        classificationReason: "No active Composio connected account exists for this toolkit",
        availableScopes,
      });
    }

    if (!resolvedActionName) {
      return this.buildReport(endpoint, null, "invalid_endpoint", null, null, {
        responseSummary: "No matching Composio action exists for this endpoint",
        errorMessage: "tool_not_found",
        dependencyStrategy: null,
        dependencySource: null,
        classificationReason: "The endpoint has no executable Composio action mapping",
        availableScopes,
      });
    }

    try {
      const prepared = await this.buildArguments(endpoint, resolvedActionName);
      const result = await this.executeAction(endpoint.toolkit, resolvedActionName, prepared.arguments);
      const status = this.classifyResult(result.error, result.successful);
      const responseSummary = summarizePayload(result.successful ? result.data : result.error);
      const errorMessage = result.successful ? null : summarizePayload(result.error);

      this.captureRuntimeState(endpoint.tool_slug, result.data);

      return this.buildReport(endpoint, resolvedActionName, status, extractHttpStatus(result.error), result.logId ?? null, {
        responseSummary,
        errorMessage,
        dependencyStrategy: prepared.dependencyStrategy,
        dependencySource: prepared.dependencySource,
        classificationReason: this.explainClassification(status, result.error),
        availableScopes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = this.classifyErrorMessage(message, null);

      return this.buildReport(endpoint, resolvedActionName, status, extractHttpStatus(error), null, {
        responseSummary: message,
        errorMessage: message,
        dependencyStrategy: null,
        dependencySource: null,
        classificationReason: this.explainClassification(status, error),
        availableScopes,
      });
    }
  }

  private async resolveActionName(toolSlug: string): Promise<string | null> {
    const mapped = Object.prototype.hasOwnProperty.call(ACTION_MAP, toolSlug)
      ? ACTION_MAP[toolSlug]
      : toolSlug;
    if (mapped === null) {
      return null;
    }
    if (await this.actionExists(mapped)) {
      return mapped;
    }
    if (mapped !== toolSlug && (await this.actionExists(toolSlug))) {
      return toolSlug;
    }
    return null;
  }

  private async actionExists(actionName: string): Promise<boolean> {
    if (this.actionCache.has(actionName)) {
      return this.actionCache.get(actionName) ?? false;
    }
    try {
      await this.composio.tools.get(USER_ID, actionName);
      this.actionCache.set(actionName, true);
      return true;
    } catch {
      this.actionCache.set(actionName, false);
      return false;
    }
  }

  private async buildArguments(endpoint: EndpointSpec, resolvedActionName: string) {
    switch (resolvedActionName) {
      case "GMAIL_GET_PROFILE":
        return { arguments: {}, dependencyStrategy: null, dependencySource: null };
      case "GMAIL_LIST_MESSAGES":
        return {
          arguments: { user_id: "me", max_results: 5 },
          dependencyStrategy: "direct_execute",
          dependencySource: null,
        };
      case "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID": {
        const messageId = await this.ensureMessageId();
        return {
          arguments: { user_id: "me", message_id: messageId, format: "full" },
          dependencyStrategy: "list_messages_then_fetch",
          dependencySource: messageId,
        };
      }
      case "GMAIL_SEND_EMAIL": {
        const recipient = await this.ensureSelfEmail();
        return {
          arguments: {
            user_id: "me",
            recipient_email: recipient,
            subject: EMAIL_SUBJECT,
            body: `This email was generated by the endpoint tester agent at ${new Date().toISOString()}.`,
          },
          dependencyStrategy: "profile_then_send_to_self",
          dependencySource: recipient,
        };
      }
      case "GMAIL_LIST_LABELS":
        return { arguments: { user_id: "me" }, dependencyStrategy: "direct_execute", dependencySource: null };
      case "GMAIL_CREATE_EMAIL_DRAFT": {
        const recipient = await this.ensureSelfEmail();
        return {
          arguments: {
            user_id: "me",
            recipient_email: recipient,
            subject: `${EMAIL_SUBJECT} draft`,
            body: `Draft generated by the endpoint tester agent at ${new Date().toISOString()}.`,
          },
          dependencyStrategy: "profile_then_create_draft",
          dependencySource: recipient,
        };
      }
      case "GMAIL_LIST_THREADS":
        return {
          arguments: { user_id: "me", max_results: 5, verbose: false, query: "" },
          dependencyStrategy: "direct_execute",
          dependencySource: null,
        };
      case "GMAIL_MOVE_TO_TRASH": {
        const messageId = await this.ensureOwnedMessageId();
        return {
          arguments: { user_id: "me", message_id: messageId },
          dependencyStrategy: "send_self_email_then_trash",
          dependencySource: messageId,
        };
      }
      case "GOOGLECALENDAR_LIST_CALENDARS":
        return { arguments: {}, dependencyStrategy: "direct_execute", dependencySource: null };
      case "GOOGLECALENDAR_CREATE_EVENT": {
        const { start, end } = buildUtcEventWindow();
        return {
          arguments: {
            calendar_id: "primary",
            summary: EVENT_TITLE,
            description: `Temporary event created by the endpoint tester agent (${RUN_ID}).`,
            start_datetime: start,
            end_datetime: end,
            timezone: TIMEZONE,
            send_updates: false,
          },
          dependencyStrategy: "create_temporary_event",
          dependencySource: EVENT_TITLE,
        };
      }
      case "GOOGLECALENDAR_FIND_EVENT":
        return {
          arguments: {
            calendar_id: "primary",
            query: "",
            max_results: 5,
            single_events: true,
            timeMin: isoForGoogle(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
            timeMax: isoForGoogle(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
          },
          dependencyStrategy: "list_events_on_primary_calendar",
          dependencySource: "primary",
        };
      case "GOOGLECALENDAR_EVENTS_GET": {
        const eventId = await this.ensureEventId();
        return {
          arguments: { calendar_id: "primary", event_id: eventId },
          dependencyStrategy: "create_or_find_event_then_get",
          dependencySource: eventId,
        };
      }
      case "GOOGLECALENDAR_DELETE_EVENT": {
        const eventId = await this.ensureOwnedEventId();
        return {
          arguments: { calendar_id: "primary", event_id: eventId },
          dependencyStrategy: "create_temporary_event_then_delete",
          dependencySource: eventId,
        };
      }
      default:
        return {
          arguments: buildFallbackArguments(endpoint),
          dependencyStrategy: "fallback_mapping",
          dependencySource: null,
        };
    }
  }

  private async ensureSelfEmail(): Promise<string> {
    if (this.selfEmail) {
      return this.selfEmail;
    }
    const result = await this.executeAction("gmail", "GMAIL_GET_PROFILE", {});
    const email = getStringAtPath(result.data, ["emailAddress"]);
    if (!email) {
      throw new Error("Unable to resolve authenticated Gmail address from GMAIL_GET_PROFILE");
    }
    this.selfEmail = email;
    return email;
  }

  private async ensureMessageId(): Promise<string> {
    if (this.listedMessageId) {
      return this.listedMessageId;
    }
    const result = await this.executeAction("gmail", "GMAIL_LIST_MESSAGES", {
      user_id: "me",
      max_results: 5,
    });
    const messageId = findFirstId(result.data, ["messages"]);
    if (!messageId) {
      throw new Error("Unable to find a Gmail message ID from GMAIL_LIST_MESSAGES");
    }
    this.listedMessageId = messageId;
    return messageId;
  }

  private async ensureOwnedMessageId(): Promise<string> {
    if (this.ownedMessageId) {
      return this.ownedMessageId;
    }

    const recipient = await this.ensureSelfEmail();
    await this.executeAction("gmail", "GMAIL_SEND_EMAIL", {
      user_id: "me",
      recipient_email: recipient,
      subject: EMAIL_SUBJECT,
      body: `This message was created for trash validation at ${new Date().toISOString()}.`,
    }).then((result) => {
      if (!result.successful) {
        throw new Error(summarizePayload(result.error));
      }
      const sentId = findFirstStringByKey(result.data, "id");
      if (sentId) {
        this.ownedMessageId = sentId;
      }
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Bun.sleep(2000);
      const listResult = await this.executeAction("gmail", "GMAIL_LIST_MESSAGES", {
        user_id: "me",
        q: `subject:"${EMAIL_SUBJECT}"`,
        max_results: 1,
      });
      const messageId = findFirstId(listResult.data, ["messages"]);
      if (messageId) {
        this.ownedMessageId = messageId;
        return messageId;
      }
    }

    throw new Error("Unable to locate the run-owned Gmail message after sending it to self");
  }

  private async ensureEventId(): Promise<string> {
    if (this.listedEventId) {
      return this.listedEventId;
    }
    if (this.createdEventId && !this.eventDeleted) {
      return this.createdEventId;
    }
    const listResult = await this.executeAction("googlecalendar", "GOOGLECALENDAR_FIND_EVENT", {
      calendar_id: "primary",
      query: "",
      max_results: 1,
      single_events: true,
      timeMin: isoForGoogle(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      timeMax: isoForGoogle(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
    });
    const foundId = findFirstId(listResult.data, ["event_data", "items", "events", "data"]);
    if (foundId) {
      this.listedEventId = foundId;
      return foundId;
    }
    return this.ensureOwnedEventId();
  }

  private async ensureOwnedEventId(): Promise<string> {
    if (this.createdEventId && !this.eventDeleted) {
      return this.createdEventId;
    }

    const { start, end } = buildUtcEventWindow();
    const createResult = await this.executeAction("googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", {
      calendar_id: "primary",
      summary: EVENT_TITLE,
      description: `Temporary event created for endpoint deletion testing (${RUN_ID}).`,
      start_datetime: start,
      end_datetime: end,
      timezone: TIMEZONE,
      send_updates: false,
    });
    if (!createResult.successful) {
      throw new Error(summarizePayload(createResult.error));
    }

    const eventId =
      findFirstStringByKey(createResult.data, "id") ??
      findFirstStringByKey(createResult.data, "event_id");
    if (!eventId) {
      throw new Error("Unable to determine event ID from GOOGLECALENDAR_CREATE_EVENT");
    }
    this.createdEventId = eventId;
    this.eventDeleted = false;
    return eventId;
  }

  private async executeAction(
    toolkit: ToolkitSlug,
    actionName: string,
    args: Record<string, unknown>
  ): Promise<ExecutionResult> {
    const account = this.accounts.get(toolkit);
    if (!account) {
      throw new Error(`No connected account for toolkit ${toolkit}`);
    }
    return (await this.composio.tools.execute(actionName, {
      userId: USER_ID,
      connectedAccountId: account.id,
      dangerouslySkipVersionCheck: true,
      arguments: args,
    })) as ExecutionResult;
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
      normalized.includes("tool not found") ||
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
        return `Composio or provider reported a missing endpoint/action: ${summarizePayload(value)}`;
      case "insufficient_scopes":
        return `Composio or provider reported a permission or scope failure: ${summarizePayload(value)}`;
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
      const eventId = findFirstStringByKey(data, "id") ?? findFirstStringByKey(data, "event_id");
      if (eventId) {
        this.createdEventId = eventId;
        this.eventDeleted = false;
      }
    }
    if (toolSlug === "GOOGLECALENDAR_LIST_EVENTS") {
      const eventId = findFirstId(data, ["event_data", "items"]);
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
      dependencyStrategy: string | null;
      dependencySource: string | null;
      classificationReason: string;
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
      dependencyStrategy: details.dependencyStrategy,
      dependencySource: details.dependencySource,
      classificationReason: details.classificationReason,
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

function buildFallbackArguments(endpoint: EndpointSpec) {
  const args: Record<string, unknown> = {};
  for (const query of endpoint.parameters.query) {
    if (query.name === "maxResults") {
      args.max_results = 5;
    } else if (query.name === "showHidden") {
      args.show_hidden = false;
    }
  }
  for (const pathParam of endpoint.parameters.path) {
    if (pathParam.name === "eventId") {
      args.event_id = "placeholder";
    }
    if (pathParam.name === "messageId") {
      args.message_id = "placeholder";
    }
  }
  return args;
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
    if (Array.isArray(candidate)) {
      const nested = findFirstId(candidate, preferredKeys);
      if (nested) {
        return nested;
      }
    }
  }
  if (typeof record.id === "string") {
    return record.id;
  }
  if (typeof record.message_id === "string") {
    return record.message_id;
  }
  if (typeof record.event_id === "string") {
    return record.event_id;
  }
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
    const nested = findFirstStringByKey(nestedValue, wantedKey);
    if (nested) {
      return nested;
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

  const outputPath = getOutputPath();
  await mkdir("reports", { recursive: true });
  const agent = new EndpointTesterAgent(process.env.COMPOSIO_API_KEY);
  await agent.run(outputPath);
}

await main();
