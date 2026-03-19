import workflow from "@convex-dev/workflow/convex.config";
import { defineComponent } from "convex/server";

const component = defineComponent("wearables");
component.use(workflow, { name: "workflow" });

export default component;
