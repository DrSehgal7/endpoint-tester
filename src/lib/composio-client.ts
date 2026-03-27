import { Composio } from "@composio/core";
import { USER_ID } from "../config/constants";
import type { ComposioWithExecute, ExecutionResult } from "../types";

export function createComposioClient(apiKey: string): ComposioWithExecute {
  const composio = new Composio({ apiKey }) as ComposioWithExecute;

  if (typeof composio.execute !== "function") {
    composio.execute = async ({ actionName, connectedAccountId, input }) => {
      return (await composio.tools.execute(actionName, {
        userId: USER_ID,
        connectedAccountId,
        dangerouslySkipVersionCheck: true,
        arguments: input,
      })) as ExecutionResult;
    };
  }

  return composio;
}
