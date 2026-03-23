import endpoints from "./endpoints.json";

// This file loads and displays the endpoint definitions you need to test.
// Use this as a starting point to understand the input data.
//
// Hint: Use composio.execute() to test endpoints. Example:
//   const result = await composio.execute({
//     actionName: "GMAIL_LIST_MESSAGES",
//     connectedAccountId: "candidate",
//     input: { maxResults: 5 },
//   });

const gmailEndpoints = endpoints.gmail.endpoints;
const calendarEndpoints = endpoints.googlecalendar.endpoints;

console.log(`\n=== Endpoint Summary ===\n`);
console.log(`Gmail endpoints: ${gmailEndpoints.length}`);
console.log(`Google Calendar endpoints: ${calendarEndpoints.length}`);
console.log(`Total: ${gmailEndpoints.length + calendarEndpoints.length}\n`);

console.log("--- Gmail ---");
for (const ep of gmailEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log("\n--- Google Calendar ---");
for (const ep of calendarEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log(`\nRequired scopes (union):`);
const allScopes = new Set([
  ...gmailEndpoints.flatMap((e) => e.required_scopes),
  ...calendarEndpoints.flatMap((e) => e.required_scopes),
]);
for (const scope of allScopes) {
  console.log(`  ${scope}`);
}
