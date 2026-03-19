import { WorkflowManager } from "@convex-dev/workflow";
import type { ComponentApi as WorkflowComponentApi } from "@convex-dev/workflow/_generated/component.js";
import { components } from "./_generated/api";

const workflowComponent = (components as unknown as {
  workflow: WorkflowComponentApi<"workflow">;
}).workflow;

export const durableWorkflow = new WorkflowManager(workflowComponent, {
  workpoolOptions: {
    maxParallelism: 5,
    retryActionsByDefault: true,
    defaultRetryBehavior: {
      maxAttempts: 4,
      initialBackoffMs: 1_000,
      base: 2,
    },
  },
});
