import { WorkflowManager } from "@convex-dev/workflow";
import type { ComponentApi as WorkflowComponentApi } from "@convex-dev/workflow/_generated/component.js";
import { components } from "./_generated/api";

// In this package, generated child components are typed as AnyComponents,
// so we narrow the installed workflow child component explicitly here.
const workflowComponent = components.workflow as unknown as WorkflowComponentApi<"workflow">;

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

const providerWebhookWorkflowComponent =
  components.providerWebhookWorkflow as unknown as WorkflowComponentApi<"providerWebhookWorkflow">;

/** Dedicated queue so bursty provider callbacks cannot starve pull sync or deletion work. */
export const providerWebhookWorkflow = new WorkflowManager(providerWebhookWorkflowComponent, {
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
