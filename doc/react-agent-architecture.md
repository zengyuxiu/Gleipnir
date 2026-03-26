# ReAct Agent Architecture

## 1. What "ReAct" means here

This project uses the agent meaning of `ReAct`:

- `Reason`: understand the user goal and decide what information is missing
- `Act`: call the right tool
- `Observe`: read tool output
- `Final`: answer with evidence and next steps

It is not about `React.js` frontend architecture.

## 2. Current architecture

The current runtime is:

1. `src/index.ts`
   - exposes HTTP endpoints such as `/chat`
   - maps requests into `runAgent(...)`

2. `src/agent.ts`
   - loads LLM config
   - reads conversation memory
   - selects an `AgentProfile`
   - builds a ReAct-style system prompt
   - runs the model with tools

3. `src/tools.ts`
   - contains all external actions
   - AgentSight event tools
   - AgentGuardian control-plane tools

4. `src/memory.ts`
   - stores session history
   - provides context for the next turn

## 3. Why use AgentProfile

Do not hardcode one huge prompt for every agent.

Use a profile per agent mode:

- `general`
- `packet-analysis`

Each profile contains:

- `name`: identity of the agent
- `goal`: what the agent should optimize for
- `reactLoop`: how it reasons and decides tool usage
- `toolRouting`: which tool should be preferred for which task
- `answerRules`: output constraints
- `stepLimit`: max tool-reasoning rounds
- `temperature`: stability of generation

This is better because:

- adding a new agent becomes a config change, not a full rewrite
- tool routing stays close to the agent definition
- different agents can use different step budgets and response styles

## 4. Recommended agent split

For this repo, a practical split is:

1. `general`
   - generic Q&A
   - AgentGuardian status / validate / reload

2. `packet-analysis`
   - AgentSight event lookup
   - stream event inspection
   - request / response evidence extraction

Future modes can be:

3. `rule-diagnosis`
   - focus on why AgentGuardian rules failed
   - summarize invalid fields and reload blockers

4. `incident-review`
   - correlate AgentSight traffic with AgentGuardian state
   - useful for production debugging

## 5. Execution flow

One request goes through this flow:

1. HTTP request enters `src/index.ts`
2. route selects `mode`
3. `runAgent(...)` loads history from memory
4. `AgentProfile` builds the ReAct system prompt
5. model decides whether to answer directly or call a tool
6. tool result returns to model as observation
7. model produces final answer
8. answer is persisted into memory

## 6. Design rule for new tools

Every tool should follow the same pattern:

- one clear responsibility
- typed input with `zod`
- typed result
- explicit failure shape
- no hidden side effects unless the tool name clearly implies mutation

Examples:

- `getAgentGuardianStatus`
- `validateAgentGuardianRules`
- `reloadAgentGuardianRules`
- `getAgentSightAiEvents`
- `getAgentSightAiEventsStream`

## 7. Design rule for new agents

When adding a new agent, follow this checklist:

1. define the user goal
2. define which tools it is allowed to prefer
3. define answer format
4. define step limit
5. add a route only if this agent needs a separate entrypoint

If the only difference is prompt behavior, add a new `AgentProfile` first.
If the agent needs different APIs, isolation, or authorization, then add a new route.

## 8. Minimal next evolution

The next good refactor would be:

- extract `AgentProfile` into `src/agents/profiles.ts`
- add `src/agents/types.ts`
- optionally add `src/agents/router.ts`

That would make the agent layer cleaner once the number of modes grows beyond two.
