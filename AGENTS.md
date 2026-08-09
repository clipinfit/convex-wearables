# Agent Guidance

Read and follow [CONTRIBUTING.md](./CONTRIBUTING.md) before planning or changing
this repository.

`convex-wearables` is an independent open-source Convex component. A consuming
application may be used as compatibility evidence, but its roadmap, policies,
or adoption timing must not define this component's scope or block releases.

The repository is an npm workspace. The publishable package lives in
`packages/convex-wearables`; runnable applications live in `apps`. Keep the
component implementation at `packages/convex-wearables/src/component` so the
package-relative `src/component` convention remains intact.
