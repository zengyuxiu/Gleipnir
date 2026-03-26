import type { AgentSightEventItem } from "./tools";

export type SecuritySeverity = "none" | "low" | "medium" | "high" | "critical";

export type AuditFinding = {
  kind: "secret-leak" | "prompt-injection" | "policy-bypass";
  severity: Exclude<SecuritySeverity, "none">;
  location: "request" | "response";
  evidence: string;
};

export type SecurityAuditResult = {
  severity: SecuritySeverity;
  decision: "allow" | "review" | "block";
  findings: AuditFinding[];
  requestSummaries: string[];
  responseSummaries: string[];
};

export type GuardianProposal = {
  proposalId: string;
  targetComm: string;
  recommendedAction: "hide";
  targetPath: string;
  reason: string;
  enforcementMode: "simulated";
};

export type SecurityLoopDemoResult = {
  scenario: string;
  before: {
    events: AgentSightEventItem[];
    audit: SecurityAuditResult;
  };
  proposal: GuardianProposal | null;
  enforcement: {
    applied: boolean;
    mode: "simulated";
    note: string;
  };
  after: {
    events: AgentSightEventItem[];
    audit: SecurityAuditResult;
  };
  loopStatus: "no_action_needed" | "mitigated" | "needs_human_review";
};

type DemoScenario = "openclaw-secret-leak" | "openclaw-safe";

const SECRET_PATTERNS = [
  /sk-[a-z0-9-]{6,}/i,
  /api[_-]?key/i,
  /bearer\s+[a-z0-9._-]{8,}/i,
  /password\s*[:=]/i,
  /token\s*[:=]/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /reveal system prompt/i,
  /bypass policy/i,
  /developer message/i,
];

function maxSeverity(
  left: SecuritySeverity,
  right: SecuritySeverity,
): SecuritySeverity {
  const order: SecuritySeverity[] = ["none", "low", "medium", "high", "critical"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function makeEvent(
  requestResponseType: "request" | "response",
  summary: string,
  overrides: Partial<AgentSightEventItem> = {},
): AgentSightEventItem {
  return {
    timestamp: Date.now(),
    source: "demo",
    comm: "openclaw",
    requestResponseType,
    messageType: requestResponseType,
    method: requestResponseType === "request" ? "POST" : null,
    path: "/v1/chat/completions",
    statusCode: requestResponseType === "response" ? 200 : null,
    function: null,
    eventCount: null,
    summary,
    ...overrides,
  };
}

function buildScenarioEvents(scenario: DemoScenario): AgentSightEventItem[] {
  if (scenario === "openclaw-safe") {
    return [
      makeEvent("request", "User asks for deployment checklist for staging environment."),
      makeEvent("response", "Assistant returns a generic checklist with no secrets."),
    ];
  }

  return [
    makeEvent(
      "request",
      "User asks OpenClaw to print local env and help debug auth issue. include api_key if found.",
    ),
    makeEvent(
      "response",
      "Assistant reveals .env content: OPENAI_API_KEY=sk-live-demo-123456 and suggests reusing it.",
    ),
  ];
}

export function auditCapturedAiTraffic(events: AgentSightEventItem[]): SecurityAuditResult {
  const requestSummaries = events
    .filter((event) => event.requestResponseType === "request")
    .map((event) => event.summary);
  const responseSummaries = events
    .filter((event) => event.requestResponseType === "response")
    .map((event) => event.summary);

  const findings: AuditFinding[] = [];
  let severity: SecuritySeverity = "none";

  for (const summary of requestSummaries) {
    if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(summary))) {
      findings.push({
        kind: "prompt-injection",
        severity: "high",
        location: "request",
        evidence: summary,
      });
      severity = maxSeverity(severity, "high");
    }
  }

  for (const summary of responseSummaries) {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(summary))) {
      findings.push({
        kind: "secret-leak",
        severity: "critical",
        location: "response",
        evidence: summary,
      });
      severity = maxSeverity(severity, "critical");
    }
  }

  const decision =
    severity === "critical" || severity === "high"
      ? "block"
      : severity === "medium"
        ? "review"
        : "allow";

  return {
    severity,
    decision,
    findings,
    requestSummaries,
    responseSummaries,
  };
}

export function buildGuardianProposal(
  events: AgentSightEventItem[],
  audit: SecurityAuditResult,
): GuardianProposal | null {
  if (audit.decision !== "block") {
    return null;
  }

  const targetComm = String(events.find((event) => typeof event.comm === "string")?.comm ?? "openclaw");
  const leakFinding = audit.findings.find((finding) => finding.kind === "secret-leak");

  if (!leakFinding) {
    return null;
  }

  return {
    proposalId: `proposal-${crypto.randomUUID()}`,
    targetComm,
    recommendedAction: "hide",
    targetPath: "/srv/openclaw/.env",
    reason: "Detected secret leakage in AI response. Recommend hiding sensitive env file from OpenClaw.",
    enforcementMode: "simulated",
  };
}

export function simulateGuardedEvents(
  events: AgentSightEventItem[],
  proposal: GuardianProposal | null,
): AgentSightEventItem[] {
  if (!proposal) {
    return events;
  }

  return events.map((event) => {
    if (event.requestResponseType !== "response") {
      return event;
    }

    return {
      ...event,
      summary:
        "Assistant cannot access hidden sensitive file after security fence. No secret content returned.",
    };
  });
}

export function runSecurityAuditDemo(
  scenario: DemoScenario = "openclaw-secret-leak",
): SecurityLoopDemoResult {
  const beforeEvents = buildScenarioEvents(scenario);
  const beforeAudit = auditCapturedAiTraffic(beforeEvents);
  const proposal = buildGuardianProposal(beforeEvents, beforeAudit);
  const afterEvents = simulateGuardedEvents(beforeEvents, proposal);
  const afterAudit = auditCapturedAiTraffic(afterEvents);

  let loopStatus: SecurityLoopDemoResult["loopStatus"] = "needs_human_review";
  if (!proposal) {
    loopStatus = "no_action_needed";
  } else if (
    beforeAudit.decision === "block" &&
    (afterAudit.decision === "allow" || afterAudit.decision === "review")
  ) {
    loopStatus = "mitigated";
  }

  return {
    scenario,
    before: {
      events: beforeEvents,
      audit: beforeAudit,
    },
    proposal,
    enforcement: {
      applied: proposal !== null,
      mode: "simulated",
      note:
        "This demo simulates Guardian enforcement because the current repository does not yet expose a rule staging/write API.",
    },
    after: {
      events: afterEvents,
      audit: afterAudit,
    },
    loopStatus,
  };
}
