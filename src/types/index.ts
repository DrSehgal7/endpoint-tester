import type { Composio } from "@composio/core";

export type ToolkitSlug = "gmail" | "googlecalendar";
export type EndpointStatus = "valid" | "invalid_endpoint" | "insufficient_scopes" | "error";

export type EndpointParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

export type EndpointBody = {
  content_type: string;
  fields: EndpointParameter[];
};

export type EndpointParameters = {
  query: EndpointParameter[];
  path: EndpointParameter[];
  body: EndpointBody | null;
};

export type EndpointCatalogEntry = {
  tool_slug: string;
  description: string;
  method: string;
  path: string;
  required_scopes: string[];
  parameters: EndpointParameters;
};

export type EndpointCatalog = {
  gmail: { endpoints: EndpointCatalogEntry[] };
  googlecalendar: { endpoints: EndpointCatalogEntry[] };
};

export type EndpointSpec = EndpointCatalogEntry & {
  toolkit: ToolkitSlug;
};

export type ConnectedAccount = {
  id: string;
  status: string;
  createdAt?: string;
  toolkit?: { slug?: string };
  state?: { val?: Record<string, unknown> };
  data?: Record<string, unknown>;
};

export type ExecutionResult = {
  successful: boolean;
  data: unknown;
  error: unknown;
  logId?: string;
};

export type ComposioExecutePayload = {
  actionName: string;
  connectedAccountId: string;
  input: Record<string, unknown>;
};

export type ComposioWithExecute = Composio & {
  execute: (payload: ComposioExecutePayload) => Promise<ExecutionResult>;
};

export type ToolProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
};

export type ToolDefinition = {
  function: {
    name: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, ToolProperty>;
      required?: string[];
    };
  };
};

export type EndpointResource =
  | "message"
  | "thread"
  | "label"
  | "profile"
  | "draft"
  | "event"
  | "calendar"
  | "reminder"
  | "unknown";

export type EndpointOperation =
  | "list"
  | "get"
  | "create"
  | "send"
  | "trash"
  | "delete"
  | "archive"
  | "unknown";

export type EndpointIntent = {
  resource: EndpointResource;
  operation: EndpointOperation;
  hasPathId: boolean;
  needsBody: boolean;
  destructive: boolean;
};

export type ActionCandidate = {
  actionName: string;
  score: number;
  reason: string;
};

export type ActionResolution = {
  actionName: string | null;
  confidence: number;
  exactMatch: boolean;
  reason: string;
  candidates: ActionCandidate[];
};

export type PlanningStep =
  | { kind: "resolve_self_email"; reason: string }
  | { kind: "resolve_message_id"; owned: boolean; reason: string }
  | { kind: "resolve_event_id"; owned: boolean; reason: string };

export type ExecutionPlan = {
  resolvedActionName: string | null;
  actionResolution: string;
  actionCandidates: ActionCandidate[];
  steps: PlanningStep[];
  arguments: Record<string, unknown>;
};

export type EndpointReportDetails = {
  responseSummary: string;
  errorMessage: string | null;
  classificationReason: string;
  actionResolution: string;
  actionCandidates: ActionCandidate[];
  planSteps: string[];
  availableScopes: string[];
};

export type EndpointReport = {
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
  actionCandidates: ActionCandidate[];
  planSteps: string[];
  logId: string | null;
};

export type RunReport = {
  generatedAt: string;
  userId: string;
  accounts: Record<ToolkitSlug, { connectedAccountId: string | null; availableScopes: string[] }>;
  summary: Record<EndpointStatus, number>;
  results: EndpointReport[];
};

export type RunContext = {
  userId: string;
  runId: string;
  eventTitle: string;
  emailSubject: string;
  timezone: string;
};
