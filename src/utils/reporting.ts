import type {
  EndpointReport,
  EndpointReportDetails,
  EndpointSpec,
  EndpointStatus,
  RunReport,
} from "../types";
import { extractHttpStatus, summarizePayload } from "./value-utils";

export function buildSummary(results: EndpointReport[]): Record<EndpointStatus, number> {
  const summary: Record<EndpointStatus, number> = {
    valid: 0,
    invalid_endpoint: 0,
    insufficient_scopes: 0,
    error: 0,
  };

  for (const result of results) {
    summary[result.status] += 1;
  }

  return summary;
}

export function classifyResult(error: unknown, successful: boolean): EndpointStatus {
  if (successful) {
    return "valid";
  }

  return classifyErrorMessage(summarizePayload(error), extractHttpStatus(error));
}

export function classifyErrorMessage(message: string, httpStatus: number | null): EndpointStatus {
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

export function explainClassification(status: EndpointStatus, value: unknown): string {
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

export function buildEndpointReport(
  endpoint: EndpointSpec,
  resolvedActionName: string | null,
  status: EndpointStatus,
  httpStatus: number | null,
  logId: string | null,
  details: EndpointReportDetails
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

export function printReportSummary(report: RunReport, outputPath: string): void {
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
