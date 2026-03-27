import endpointCatalog from "../endpoints.json";
import type { EndpointCatalog, EndpointSpec, RunContext, ToolkitSlug } from "../types";

export const USER_ID = "candidate";
export const DEFAULT_OUTPUT = "reports/endpoint-test-report.json";
export const TIMEZONE = "UTC";
export const TOOLKITS = ["gmail", "googlecalendar"] as const satisfies readonly ToolkitSlug[];

export const RUN_CONTEXT: RunContext = createRunContext();

const catalog = endpointCatalog as EndpointCatalog;

export const ENDPOINTS: EndpointSpec[] = [
  ...catalog.gmail.endpoints.map((endpoint) => ({ ...endpoint, toolkit: "gmail" as const })),
  ...catalog.googlecalendar.endpoints.map((endpoint) => ({
    ...endpoint,
    toolkit: "googlecalendar" as const,
  })),
];

function createRunContext(now = Date.now()): RunContext {
  const runId = `run-${now}`;

  return {
    userId: USER_ID,
    runId,
    eventTitle: `[Endpoint Tester] ${runId} calendar fixture`,
    emailSubject: `[Endpoint Tester] ${runId} mailbox fixture`,
    timezone: TIMEZONE,
  };
}
