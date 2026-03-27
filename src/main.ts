import { mkdir } from "node:fs/promises";
import { DEFAULT_OUTPUT } from "./config/constants";
import { EndpointTesterAgent } from "./agent/endpoint-tester-agent";

function getOutputPath(): string {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0 && process.argv[outIndex + 1]) {
    return process.argv[outIndex + 1];
  }

  return DEFAULT_OUTPUT;
}

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is required. Run setup.sh or export the key before executing the agent.");
  }

  await mkdir("reports", { recursive: true });

  const agent = new EndpointTesterAgent(apiKey);
  await agent.run(getOutputPath());
}

await main();
