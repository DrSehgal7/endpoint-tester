# Endpoint Tester Agent Plan

## Summary
- Build a Bun-based TypeScript **agent**, not just a linear script, that reads `src/endpoints.json`, reasons about endpoint dependencies, tests every endpoint through **`composio.execute()`**, and writes a structured JSON report.
- Keep the implementation aligned with the README’s judging criteria: correctness, completeness, agent design, and clean abstractions for execution, classification, dependency handling, and reporting.
- Treat the Google REST method/path data in `src/endpoints.json` as the test specification and the Composio action names as the execution interface, with a small internal resolution layer only where needed to ensure the agent can still test the intended endpoint.

## Agent Design
- Implement a central `EndpointTesterAgent` that owns:
  - endpoint intake and normalization
  - dependency planning
  - fixture discovery and creation
  - sequential or rate-limited execution
  - result classification
  - final report generation
- Make the runtime visibly agentic rather than a plain loop:
  - inspect each endpoint before execution
  - decide whether it can run immediately or needs prerequisite data
  - fetch prerequisite IDs from list endpoints when required
  - construct minimal valid payloads for POST endpoints
  - continue testing every endpoint independently even if related endpoints fail
- Keep the reasoning traceable in the report with fields such as:
  - `dependencyStrategy`
  - `dependencySource`
  - `classificationReason`
  - `responseSummary`

## Execution Plan
- Load all 16 endpoint definitions from `src/endpoints.json` and preserve for each result:
  - `toolSlug`
  - `method`
  - `path`
  - `requiredScopes`
- Add a lightweight resolution layer that maps each endpoint entry to the exact `composio.execute()` call needed at runtime:
  - `actionName`
  - `connectedAccountId`
  - `input`
- Execute endpoints only through Composio’s execution layer, matching the README requirement:
  - use `composio.execute()`
  - do not issue raw HTTP requests
  - do not extract bearer tokens manually
- Dependency handling:
  - `GMAIL_GET_MESSAGE` and `GMAIL_TRASH_MESSAGE` first obtain a real `messageId` from `GMAIL_LIST_MESSAGES`
  - `GOOGLECALENDAR_GET_EVENT` first obtains a real `eventId` from `GOOGLECALENDAR_LIST_EVENTS` or from a temporary created event
  - `GOOGLECALENDAR_DELETE_EVENT` should prefer deleting a run-owned temporary event created earlier in the same run
- Minimal payload handling:
  - Gmail send and draft endpoints should build the smallest valid RFC 2822 message and base64url-encode it
  - Calendar create-event should build a short future event with valid `start` and `end`
- Rate limiting:
  - default to sequential execution
  - allow a small controlled concurrency only if it preserves readable reasoning and avoids bursts
  - include basic retry handling for transient failures if time permits

## Classification And Reporting
- Every endpoint must receive its own final result, even if dependency discovery fails elsewhere.
- Use exactly the README classification set:
  - `valid`
  - `invalid_endpoint`
  - `insufficient_scopes`
  - `error`
- Classification rules:
  - successful Composio execution -> `valid`
  - provider 404 or equivalent “endpoint/action does not exist” signal -> `invalid_endpoint`
  - provider 403 or equivalent permission failure -> `insufficient_scopes`
  - any other unexpected SDK, payload, dependency, or runtime issue -> `error`
- Report shape per endpoint:
  - `toolSlug`
  - `method`
  - `path`
  - `status`
  - `httpStatus`
  - `responseSummary`
  - `errorMessage`
  - `requiredScopes`
  - `availableScopes`
- Report output:
  - write machine-readable JSON to `reports/endpoint-test-report.json`
  - print a short terminal summary showing counts by status and notable failures

## Safety And Data Handling
- Respect the README requirement to test endpoints independently while still being careful with user data.
- Safe mutation strategy:
  - prefer temporary, run-owned resources for Calendar create/get/delete flows
  - allow Gmail send and draft with minimal self-contained payloads
  - only use trash on a message ID the run intentionally selected for testing
- If an endpoint cannot be safely or validly exercised with the current account state, still test it and classify based on the actual Composio outcome; only fall back to `error` when the failure is genuinely unexpected rather than an endpoint-validity or scope signal.

## Implementation Structure
- Suggested modules:
  - `src/agent.ts` for agent orchestration
  - `src/composio.ts` for `composio.execute()` wrappers
  - `src/dependencies.ts` for ID discovery and fixture planning
  - `src/classifier.ts` for status mapping
  - `src/report.ts` for JSON output
  - `src/main.ts` as the Bun entrypoint
- Core types:
  - `EndpointSpec`
  - `ExecutionPlan`
  - `EndpointExecutionResult`
  - `EndpointReport`
  - `TestReport`

## Test Plan
- Unit tests with Bun mocks for:
  - endpoint-to-`composio.execute()` input mapping
  - dependency resolution for message and event IDs
  - payload generation for Gmail send, draft, and Calendar create
  - classification of success, 403, 404, and unexpected failures
  - report generation for all 16 endpoints
- Manual or integration verification:
  - setup via `COMPOSIO_API_KEY=<key> sh setup.sh`
  - confirm the agent runs against connected Gmail and Calendar accounts
  - verify all 16 endpoints appear in the final JSON output
  - verify fake endpoints are caught
  - verify scope failures are surfaced as `insufficient_scopes` when encountered

## Deliverables
- A working Bun/TypeScript agent implementation.
- A JSON report covering all 16 endpoints.
- Clean, readable source code showing agent reasoning, dependency handling, classification, and reporting.
- A short Loom video explaining what was built, the key decisions, and any tradeoffs.

## Assumptions
- The implementation should honor the assignment wording and use `composio.execute()` as the primary execution interface.
- A small internal mapping layer is acceptable only to bridge from the provided endpoint catalog to the concrete Composio action invocation required to test the intended endpoint.
- Bonus items such as a dashboard, smarter retries, or controlled parallelism should only be added after the core agent and report are complete.
