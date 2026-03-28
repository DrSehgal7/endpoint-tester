import type { EndpointSpec } from "../types";

export function buildScopeSuggestions(endpoint: EndpointSpec, availableScopes: string[]): string[] {
  const missingScopes = endpoint.required_scopes.filter((scope) => !availableScopes.includes(scope));
  const candidateScopes = missingScopes.length > 0 ? missingScopes : endpoint.required_scopes;
  const suggestions = candidateScopes.map((scope) => {
    const unlock = describeScopeUnlock(endpoint, scope);
    return `Grant ${scope} to unlock ${unlock}.`;
  });

  if (candidateScopes.length === 0) {
    return [];
  }

  suggestions.push(
    missingScopes.length > 0
      ? `Currently available scopes do not fully cover ${endpoint.method} ${endpoint.path}. Reconnect the ${endpoint.toolkit} account with the missing scopes to validate this endpoint.`
      : `The provider still reported insufficient scopes for ${endpoint.method} ${endpoint.path}. Reconnect the ${endpoint.toolkit} account and explicitly approve the required scopes again, because the saved connected-account scope list may be stale or incomplete.`
  );

  return suggestions;
}

function describeScopeUnlock(endpoint: EndpointSpec, scope: string): string {
  const resourceLabel = describeEndpointTarget(endpoint);

  if (scope.includes("gmail.modify")) {
    return `message mutation actions for ${resourceLabel}`;
  }

  if (scope.includes("gmail.compose")) {
    return `draft and send actions for ${resourceLabel}`;
  }

  if (scope.includes("gmail.readonly")) {
    return `read access for ${resourceLabel}`;
  }

  if (scope.includes("calendar.events")) {
    return `event create, read, and delete actions for ${resourceLabel}`;
  }

  if (scope.includes("calendar.readonly")) {
    return `read access for ${resourceLabel}`;
  }

  if (scope.includes("calendar")) {
    return `calendar management access for ${resourceLabel}`;
  }

  return `${endpoint.method} ${endpoint.path}`;
}

function describeEndpointTarget(endpoint: EndpointSpec): string {
  if (endpoint.path.includes("/messages")) return "Gmail messages";
  if (endpoint.path.includes("/threads")) return "Gmail threads";
  if (endpoint.path.includes("/labels")) return "Gmail labels";
  if (endpoint.path.includes("/profile")) return "the Gmail profile";
  if (endpoint.path.includes("/drafts")) return "Gmail drafts";
  if (endpoint.path.includes("/events")) return "Calendar events";
  if (endpoint.path.includes("calendarList")) return "calendar listing";
  return "this endpoint";
}
