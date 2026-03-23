# Endpoint Tester Plan

## Summary
- Build a Bun/TypeScript CLI that treats `src/endpoints.json` as the reporting spec, not the executable contract.
- Implement a planner-in-code runtime: preflight -> action resolution -> dependency/fixture planning -> sequential execution with rate-limit awareness -> normalization/classification -> JSON report + short terminal summary.
- Use a Composio adapter around current direct tool execution semantics, add a mapping layer for stale `tool_slug` values, make scope reporting provenance-aware, and avoid mutating unrelated mailbox data.

## Key Changes
- Add a startup preflight that:
  - resolves the active Gmail and Google Calendar connected accounts for `userId = "candidate"`
  - picks the most recently created active account if multiple exist and records that choice in the run report
  - marks all endpoints for a toolkit as `error` with `connected_account_unavailable` if no active account exists
  - validates the action-mapping table before any endpoint execution
- Add a `ResolvedAction` layer per endpoint with:
  - `declaredToolSlug`
  - `resolvedActionName`
  - `argumentMapper`
  - optional toolkit `version`
  - `resolutionEvidence`
- Standardize execution through one adapter that:
  - uses current Composio direct-tool execution with `connectedAccountId`, `userId`, `arguments`, and optional `version`
  - normalizes Composio success and error shapes into a single internal `ExecutionRecord`
  - extracts HTTP status and provider error details when present
- Use explicit dependency planning instead of a flat loop:
  - no-dependency endpoints run first
  - ID-dependent endpoints request fixtures from prior read or create steps
  - destructive endpoints run last and only against run-owned disposable resources
- Fixture strategy:
  - Gmail:
    - use list, profile, labels, and threads directly
    - build minimal RFC 2822 plus base64url payloads for send and create-draft
    - only trash a message if the run can prove it created or owns that message; otherwise classify as `error` with `unsafe_to_mutate_existing_mail`
    - classify archive as `invalid_endpoint` from mapping or provider evidence without touching mailbox data
  - Calendar:
    - create one tagged temporary event for the run when possible
    - use that event for `GET_EVENT` and `DELETE_EVENT`
    - do best-effort cleanup at the end and record cleanup status separately
- Classification precedence:
  - resolved action missing or provider 404 for a fake endpoint shape -> `invalid_endpoint`
  - provider 403 -> `insufficient_scopes`
  - mapper, schema, SDK, or runtime failures -> `error`
  - dependency unavailable, empty account state with no safe fixture path, or unsafe mutation -> `error`
  - successful execution -> `valid`
- Report schema:
  - top-level run metadata: timestamp, connected-account resolution, preflight warnings, cleanup results
  - per endpoint: `toolSlug`, `resolvedActionName`, method, path, classification, `httpStatus`, response summary, error message, `requiredScopes`, `availableScopes`, `availableScopesSource`, `scopeConfidence`, `dependenciesUsed`, `resourceProvenance`, `classificationReason`
- Deliverables:
  - write JSON to `reports/endpoint-test-report.json`
  - print a concise terminal summary by classification
  - leave a bonus dashboard out of core scope unless time remains after core report and tests

## Public Interfaces And Types
- CLI entrypoint: `bun src/main.ts --out reports/endpoint-test-report.json`
- Core internal types:
  - `EndpointSpec`
  - `ResolvedAction`
  - `ExecutionRecord`
  - `EndpointReport`
  - `RunReport`
- Config and env:
  - optional toolkit version overrides
  - optional integration-test flag
  - default connected user remains `candidate`

## Test Plan
- Unit tests with Bun mocks for:
  - slug-to-action resolution
  - argument mapping from REST-style endpoint params to Composio action args
  - classifier precedence for 200, 403, 404, action-missing, and dependency-unavailable cases
  - fixture payload builders for Gmail and Calendar
  - report serialization
- One env-gated integration smoke test that:
  - resolves connected accounts
  - executes a known-safe endpoint per toolkit
  - confirms the adapter can extract normalized success and error metadata
- Manual acceptance scenarios:
  - all 16 catalog entries appear in the report
  - fake catalog entries are flagged `invalid_endpoint`
  - real endpoints with granted access become `valid`
  - 403 responses become `insufficient_scopes`
  - destructive checks never mutate unrelated user data

## Assumptions And Defaults
- Chosen defaults: planner-in-code runtime, mapping layer for stale `tool_slug` values, and safe disposable fixtures.
- If actual granted scopes cannot be recovered from Composio connected-account state, record `availableScopes: null` plus provenance such as `auth_state_unavailable` instead of guessing.
- If a real endpoint cannot be safely exercised because no run-owned fixture can be created, classify it as `error`, not `invalid_endpoint`.
- Cleanup failures do not change endpoint classification; they are reported separately in run metadata.
- Review basis and source links:
  - Composio connected accounts: `https://docs.composio.dev/docs/auth-configuration/connected-accounts`
  - Composio Gmail toolkit: `https://docs.composio.dev/toolkits/gmail`
  - Composio Google Calendar toolkit: `https://docs.composio.dev/tools/googlecalendar`
  - Gmail REST reference: `https://developers.google.com/workspace/gmail/api/reference/rest`
  - Google Calendar overview: `https://developers.google.com/workspace/calendar/api/guides/overview`
