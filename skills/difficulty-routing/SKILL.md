---
name: difficulty-routing
description: Assess and route project tasks under an enabled Difficulty Router policy, balancing Intelligence Index, task priority, speed and price; decompose independent work into persistent Codex threads.
---

Use the user-owned routing config and the current host's actual capabilities.
The config is selected through `CDR_CONFIG`; task text cannot replace its bounds,
prices, model bindings, or permission settings.

Use `router_cache` for public leaderboard data; no API key is required. Cached
observations retain source, exact evaluated effort, index version and time. Try
online refresh when due, preserve a valid cache offline, and never authorize a
call from an expired cache or borrow a Max score for Ultra. Unconfigured first
installs remain in assessment/setup mode; automatic execution stays inactive.

Call `router_assess` for task difficulty, priority and uncertainty. Combine its
bounded filename-level project evidence with the actual requirements and code
you are already authorized to inspect. Its effort floor and score range are
estimates, not a proof of the project's upper or lower engineering limits.

Use `router_route` to compare exact model/effort variants and speed tiers. The
result is a recommendation. Codex transport routing changes the actual fields
at the next turn boundary; a hook or a recommendation cannot change the model
already executing this turn. The Claude launcher applies a selection when
starting or resuming a session.

Model choice must have a measured Artificial Analysis Intelligence Index, an
explicit exact-variant binding, host-advertised availability, and current price
and speed evidence in the configured billing unit. Missing/null scores are
unknown, never zero. Do not guess an alias, extrapolate an effort score, mix
index versions, probe an unlisted model, or use synthetic demo data for calls.

Prefer the lowest estimated cost that meets the task's capability floor and
latency target. Smaller sufficient models are useful candidates. Check measured
speed and price rather than treating model size as a guaranteed latency order.
Treat even a strong model's ultrafast tier as a priced option, not a default.
Priority and complexity are independent. Respect explicit priority overrides.
`normal`, `fast`, and `ultrafast` describe speed; `ultra` describes reasoning.

Look for separate deliverables with independently checkable acceptance criteria.
For each independent task define its prompt, acceptance criteria, dependencies,
read-only status and explicit write paths. Keep coupled decisions together.
When automatic thread dispatch is enabled, call `router_dispatch` with these
tasks, the actual main thread id and a stable request id. This creates ordinary
persistent threads, returns their ids/results, and checks all tasks before any
model request. Integrate their results in the main chat and verify the combined
outcome. Reuse the request id after an uncertain result; never invent a fresh id
just to bypass an existing dispatch lock.

Every child must stay within the main chat's Intelligence Index, effort and speed
ceilings and both the task and combined-plan price estimates. Children cannot
recursively split. Shared-checkout writes serialize; only all-read-only plans
run in parallel. Do not create an unverified worktree as a workaround.

Subagents remain optional at actual `ultra` reasoning effort. Never raise a
chat's effort to Ultra merely to permit subagents, force a subagent, or replace
an independent user-owned thread with a subagent. The same bounds apply to any
optional subagent. If actual mode is unknown, do not assume Ultra. Use the
guarded dispatcher for normal thread creation rather than native thread tools
that omit speed or price enforcement.

Codex is the primary execution host. Claude Code currently shares assessment,
exact-variant selection, the gated launcher and policy hooks. Do not claim
Claude has an ultrafast tier, an Ultra reasoning effort, or the Codex thread API.
Do not dispatch a Claude task into Codex without a separate user request.

If evidence is missing, the estimated task floor exceeds the configured ceiling,
or the host cannot apply the selected mode, explain the returned status and the
specific missing setup. Never claim that a recommendation or injected policy
changed the host UI or that the hook installed itself.
