/// <reference types="vite/client" />

import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with a test Convex instance.
 * @param t - The test Convex instance, for example from `convexTest`.
 * @param name - The component name, as registered in the host app.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "wearables",
) {
  t.registerComponent("workflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "workflow/workpool");
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
