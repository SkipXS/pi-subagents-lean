# ADR 0001: Fixed stable public tool schemas

## Decision

Register the two public tools, `Agent` and `AgentContinue`, once at extension
initialization with fixed strict schemas and concise static descriptions. The
schemas contain only the public parameters required by their contracts:

- `Agent`: `prompt`, `agent`, optional `description` and `worktree_path`.
- `AgentContinue`: `agent_id` and `prompt`.

Dynamic catalogs, model choices, thinking levels, scheduling, trust, and
resource selections are resolved internally. They are not runtime-generated
enums or public tool parameters. The schemas reject unknown properties.

Parent orchestration is mandatory. Before every parent turn, the extension
refreshes the trust-scoped live catalog and replaces its owned orchestration
block in the parent system prompt. This parent-only block is the automatic
catalog of available roles; it is not injected into child sessions. The fixed
tool schema and the live catalog therefore have separate responsibilities.

## Why

Re-registering a tool during a session can rebuild the system prompt and churn
the provider's reusable prompt prefix. A fixed schema keeps recurring tool
shape stable while allowing role descriptions and trust-scoped availability to
change in the parent orchestration block.

Dynamic model and thinking resolution remains validated against Pi's model
registry and provider capabilities, but putting it in the tool schema would
make the public contract mutable and encourage the model to control policy
that belongs to configuration, role Markdown, and the parent session.

## Consequences

The tool descriptions and parameter names must carry the stable public meaning,
while result metadata explains accepted role, ID, model, thinking, and current
execution details. Catalog refresh never changes the schema, and schema
stability never makes a stale catalog authoritative. Children receive neither
`Agent` nor `AgentContinue`, so parent orchestration remains a root-only concern.
