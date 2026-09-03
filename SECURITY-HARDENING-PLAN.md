# Low-risk security hardening plan

## Goal

Protect explicit user image workflows without changing the ChatGPT subscription
authentication route or preventing users from selecting legitimate local images.

## Delivered in this change

- Create generated output files exclusively, then select `-v2` through `-v999`
  names on collision. Concurrent generations therefore cannot overwrite each
  other's output.
- Document that every selected reference image is uploaded to the ChatGPT Codex
  backend and that the plugin itself cannot prove whether a path came from a
  person or an agent.

## Deliberately not implemented here

- A directory allowlist or hard input-size cap. Both would reject valid,
  explicitly user-selected assets.
- A boolean "user approved" tool argument. The agent invoking the tool could set
  that value, so it would not create a security boundary.
- Changes to OAuth handling or the undocumented Codex transport. Those increase
  compatibility risk without addressing file-selection intent.

## Host-level follow-up

The durable boundary belongs in OpenCode: reference-image reads should require a
host-managed attachment or an explicit user confirmation when the path was
chosen by an agent. Such a capability must be enforced outside the plugin's
agent-controlled arguments.

Until that capability exists, use the plugin only in sessions where the agent is
already permitted to read and upload the selected images. For unusually large
images, a host may warn before reading them to prevent accidental memory pressure
without blocking deliberate user selection.

## Verification

- Unit test simultaneous output requests and confirm that both files are
  preserved with distinct names.
- Run the existing typecheck, formatter/linter, and unit-test commands.
