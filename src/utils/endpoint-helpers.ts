import type { EndpointIntent, EndpointOperation, EndpointResource, EndpointSpec, PlanningStep } from "../types";

export function analyzeIntent(endpoint: EndpointSpec): EndpointIntent {
  const path = endpoint.path.toLowerCase();
  const hasPathId = endpoint.parameters.path.length > 0;

  let operation: EndpointOperation = "unknown";
  if (endpoint.method === "GET" && !hasPathId) operation = "list";
  if (endpoint.method === "GET" && hasPathId) operation = "get";
  if (endpoint.method === "DELETE") operation = "delete";
  if (endpoint.method === "POST" && path.endsWith("/send")) operation = "send";
  if (endpoint.method === "POST" && path.endsWith("/trash")) operation = "trash";
  if (endpoint.method === "POST" && path.endsWith("/archive")) operation = "archive";
  if (endpoint.method === "POST" && operation === "unknown") operation = "create";

  return {
    resource: inferResource(path),
    operation,
    hasPathId,
    needsBody: endpoint.parameters.body !== null,
    destructive: operation === "trash" || operation === "delete" || operation === "archive",
  };
}

export function generateCandidateActionNames(endpoint: EndpointSpec): string[] {
  const intent = analyzeIntent(endpoint);
  const prefix = endpoint.toolkit === "gmail" ? "GMAIL" : "GOOGLECALENDAR";
  const candidates = new Set<string>([endpoint.tool_slug]);

  for (const operation of OPERATION_VARIANTS[intent.operation]) {
    for (const resource of RESOURCE_VARIANTS[intent.resource]) {
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

export function renderPlanningStep(step: PlanningStep): string {
  if (step.kind === "resolve_self_email") {
    return step.reason;
  }

  const suffix = step.owned ? " (owned fixture)" : " (existing fixture)";
  return `${step.reason}${suffix}`;
}

export function buildUtcEventWindow() {
  const startDate = new Date(Date.now() + 2 * 60 * 60 * 1000);
  startDate.setUTCMinutes(0, 0, 0);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  return {
    start: startDate.toISOString().slice(0, 19),
    end: endDate.toISOString().slice(0, 19),
  };
}

export function isoForGoogle(date: Date): string {
  return date.toISOString();
}

function inferResource(path: string): EndpointResource {
  if (path.includes("/messages")) return "message";
  if (path.includes("/threads")) return "thread";
  if (path.includes("/labels")) return "label";
  if (path.includes("/profile")) return "profile";
  if (path.includes("/drafts")) return "draft";
  if (path.includes("/events")) return "event";
  if (path.includes("calendarlist")) return "calendar";
  if (path.includes("/reminders")) return "reminder";

  return "unknown";
}

const RESOURCE_VARIANTS: Record<EndpointResource, string[]> = {
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

const OPERATION_VARIANTS: Record<EndpointOperation, string[]> = {
  list: ["LIST", "FIND"],
  get: ["GET", "FETCH"],
  create: ["CREATE", "INSERT"],
  send: ["SEND"],
  trash: ["MOVE_TO_TRASH", "TRASH"],
  delete: ["DELETE"],
  archive: ["ARCHIVE"],
  unknown: [],
};
