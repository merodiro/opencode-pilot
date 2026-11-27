import { Model, Plugin, Provider } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { JevStatus, type JevDecision, type JevRoute } from "./rpc.js";

type PlanningRoute = "quick" | "standard" | "complex";
type Route = PlanningRoute | "implementation";

const CLASSIFIERS = [Model.Ref.parse("opencode/jev-1.13-free")];
const COMPLEX_THRESHOLD = 0.5;
// 0.85 asked for near-certainty before trusting the quick model, but the log
// shows 88 turns in the 0.6-0.85 band where quick was right: "commit the
// changes", "remove .claude", "how does it integrate with shadcn?". Standard
// was paying planning cost for work quick handled in one or two tools.
const QUICK_THRESHOLD = 0.7;
const QUICK_MARGIN = 0.15;
// High-stakes work earns one extra tier: a reversible quick question stays
// quick, but irreversible/production/security/payments/migration work is bumped
// quick -> standard -> complex. Mirrors smart-reasoning's noul bump, asked as a
// parallel predicate since generate.decisions has no noul type.
const STAKES_THRESHOLD = 0.7;
// A stakes bump is about caution, not planning depth. The log shows two turns
// ("allow global access to work trees", "remove your work trees") with a 0.8
// stakes score and 0.16 or less complex probability that were pushed from
// standard to complex: config edits on the most expensive tier. Past the
// stakes bar the route still moves up, but it only reaches complex when the
// turn also looks structurally hard.
const STAKES_COMPLEX_FLOOR = 0.25;
// Cheap override borrowed from smart-reasoning: no Jev call worth it here.
const MAX_KEYWORDS = ["ultrathink"];
const MAX_CLASSIFIER_INPUT = 16_000;
const MAX_RECENT_REQUESTS = 3;
const FAILURE_STREAK = 2;
const FAILURE_TOTAL = 3;
// Second-stage failure triage (#4): a struggling turn is not escalated blindly.
// Jev decides whether the evidence looks transient (retry on implementation
// route) or structural (escalate to the hard model).
const FAILURE_ESCALATE_THRESHOLD = 0.6;
const MAX_FAILURE_RETRIES = 2;
const MAX_FAILURE_EVIDENCE = 3;
const MAX_EVIDENCE_CHARS = 1_000;
const DECISION_LOG_LIMIT = 60;
// Log-format changes that do not move a threshold still need their own version,
// so old records are never read as if they had the new fields.
const POLICY_VERSION = 2;

// Decisions are only useful when they can be grouped by the policy that produced
// them. The fingerprint covers every knob that changes routing behaviour, so a
// log collected before a tuning change is not silently mixed with the new one.
// Route-table changes are visible per record in `resolvedModel`.
const ROUTER_VERSION = (() => {
  const signature = JSON.stringify({
    policy: POLICY_VERSION,
    complex: COMPLEX_THRESHOLD,
    quick: QUICK_THRESHOLD,
    margin: QUICK_MARGIN,
    streak: FAILURE_STREAK,
    total: FAILURE_TOTAL,
    escalate: FAILURE_ESCALATE_THRESHOLD,
    retries: MAX_FAILURE_RETRIES,
    skillGate: "invoked-skills",
    stakes: STAKES_THRESHOLD,
    stakesComplex: STAKES_COMPLEX_FLOOR,
    keywords: MAX_KEYWORDS,
  });
  let hash = 5381;
  for (let index = 0; index < signature.length; index++) {
    hash = ((hash * 33) ^ signature.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
})();

const ROUTES = {
  quick: Model.Ref.parse("opencode-go/hy4-flash-free#none"),
  standard: Model.Ref.parse("opencode-go/muse-spark-1.3-contributor"),
  complex: Model.Ref.parse("opencode-go/muse-spark-1.3-contributor#xhigh"),
  // Long tool loops care about throughput, and keeping execution off the
  // region-gated model means a Muse block cannot stall implementation.
  implementation: Model.Ref.parse("opencode-go/deepseek-v4.1-flash#high"),
} satisfies Record<Route, Model.Ref>;

const LITE_ROUTES = {
  quick: Model.Ref.parse("opencode/hy4-flash-free#none"),
  standard: Model.Ref.parse("opencode/hy4-flash-free#high"),
  complex: Model.Ref.parse("opencode/seaglass-alpha-free#max"),
  implementation: Model.Ref.parse("opencode/hy4-flash-free#high"),
} satisfies Record<Route, Model.Ref>;

// Complex turns and escalation must be different families: the usual reason a
// free turn struggles is a per-model rate limit, and escalating back to the
// model that is already failing would change nothing. DeepSeek free also has
// the strongest measured score of the free models and a zero-retention policy.
const LITE_ESCALATION = Model.Ref.parse("opencode/deepseek-v4.1-flash-free#max");

const AUXILIARY_ROUTES = {
  title: Model.Ref.parse("opencode-go/hy4-flash-free#none"),
  compaction: Model.Ref.parse("opencode-go/hungerg-free"),
  generate: Model.Ref.parse("opencode-go/hy4-flash-free#none"),
} satisfies Record<"title" | "compaction" | "generate", Model.Ref>;

const LITE_AUXILIARY_ROUTES = {
  title: Model.Ref.parse("opencode/hy4-flash-free#none"),
  compaction: Model.Ref.parse("opencode/deepseek-v4.1-flash-free#high"),
  generate: Model.Ref.parse("opencode/hy4-flash-free#none"),
} satisfies Record<"title" | "compaction" | "generate", Model.Ref>;

const CLAUDE_ROUTES = {
  quick: Model.Ref.parse("claude-agent/haiku#low"),
  standard: Model.Ref.parse("claude-agent/sonnet#medium"),
  complex: Model.Ref.parse("claude-agent/opus#medium"),
  implementation: Model.Ref.parse("claude-agent/sonnet#medium"),
} satisfies Record<Route, Model.Ref>;

const CLAUDE_AUXILIARY_ROUTES = {
  title: Model.Ref.parse("claude-agent/haiku#low"),
  compaction: Model.Ref.parse("claude-agent/sonnet#medium"),
  generate: Model.Ref.parse("claude-agent/haiku#low"),
} satisfies Record<"title" | "compaction" | "generate", Model.Ref>;

const SUBAGENT_MODEL = Model.Ref.parse("opencode/jev-sub");

const SUBAGENT_ROUTES = {
  quick: Model.Ref.parse("opencode/hy4-flash-free#none"),
  standard: Model.Ref.parse("opencode/hy4-flash-free#high"),
  complex: Model.Ref.parse("opencode/seaglass-alpha-free#max"),
} satisfies Record<PlanningRoute, Model.Ref>;

// Free models rate-limit per model. A struggling subagent switches families to
// DeepSeek free instead of retrying the model that is failing, and stays free:
// the `opencode` provider has no paid balance, and the resolve hook only accepts
// another model from the session's own provider.
const SUBAGENT_ESCALATION = Model.Ref.parse("opencode/deepseek-v4.1-flash-free#max");

const SUBAGENT_AUXILIARY = {
  title: Model.Ref.parse("opencode/hy4-flash-free#none"),
  compaction: Model.Ref.parse("opencode/hy4-flash-free#high"),
  generate: Model.Ref.parse("opencode/hy4-flash-free#none"),
} satisfies Record<"title" | "compaction" | "generate", Model.Ref>;

function isSubagentModel(providerID: string, modelID: string): boolean {
  return providerID === "opencode" && modelID === "jev-sub";
}

function routesFor(providerID: string, modelID: string) {
  if (providerID === "opencode-go" && modelID === "jev-auto") return ROUTES;
  if (providerID === "opencode" && modelID === "jev-lite") return LITE_ROUTES;
  if (providerID === "claude-agent" && modelID === "jev-claude")
    return CLAUDE_ROUTES;
}

function auxiliaryFor(providerID: string) {
  if (providerID === "opencode") return LITE_AUXILIARY_ROUTES;
  if (providerID === "claude-agent") return CLAUDE_AUXILIARY_ROUTES;
  return AUXILIARY_ROUTES;
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"]);

type Messages = Awaited<ReturnType<Context["session"]["context"]>>;

interface RouterState {
  userMessageID: string;
  phase: "planning" | "implementation";
  /** The route classification for the turn; "implementation" only in older state. */
  route: Route;
  /** Set once the turn showed struggle; keeps the hard model for the rest of the turn. */
  escalated?: boolean;
  /** Failure count when the last retry was granted; newer failures are triaged again. */
  retryAt?: number;
  /** Retries granted this turn; the cap forces escalation. */
  retries?: number;
}

function isRoute(value: unknown): value is Route {
  return (
    value === "quick" ||
    value === "standard" ||
    value === "complex" ||
    value === "implementation"
  );
}

function parseState(value: unknown): RouterState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const state = value as Record<string, unknown>;
  if (typeof state.userMessageID !== "string" || !isRoute(state.route)) return;
  if (state.phase !== "planning" && state.phase !== "implementation") return;
  const count = (input: unknown, min: number) =>
    typeof input === "number" && Number.isInteger(input) && input >= min
      ? input
      : undefined;
  const retryAt = count(state.retryAt, 0);
  const retries = count(state.retries, 1);
  return {
    userMessageID: state.userMessageID,
    phase: state.phase,
    route: state.route,
    ...(state.escalated === true ? { escalated: true } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(retries !== undefined ? { retries } : {}),
  };
}

function lastUserIndex(messages: Messages): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].type === "user") return index;
  }
  return -1;
}

function editedThisTurn(messages: Messages, userIndex: number): boolean {
  return messages.slice(userIndex + 1).some((message) => {
    if (message.type !== "assistant") return false;
    return message.content.some(
      (part) =>
        part.type === "tool" &&
        EDIT_TOOLS.has(part.name) &&
        part.state.status === "completed",
    );
  });
}

interface FailureEvidence {
  kind: "tool" | "model";
  name: string;
  error: string;
  status?: number;
}

interface Failures {
  total: number;
  longestStreak: number;
  /** Assistant messages whose model request failed outright (rate limits, outages). */
  modelErrors: number;
  /** Failed tool calls and model requests, oldest first, for failure triage. */
  evidence: FailureEvidence[];
}

function toolFailures(messages: Messages, userIndex: number): Failures {
  let total = 0;
  let streak = 0;
  let longestStreak = 0;
  let modelErrors = 0;
  const evidence: FailureEvidence[] = [];
  const fail = () => {
    total++;
    streak++;
    longestStreak = Math.max(longestStreak, streak);
  };
  for (const message of messages.slice(userIndex + 1)) {
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool") continue;
      if (part.state.status === "error") {
        fail();
        evidence.push({
          kind: "tool",
          name: part.name,
          error: part.state.error.message.slice(0, MAX_EVIDENCE_CHARS),
          ...(part.state.error.status !== undefined
            ? { status: part.state.error.status }
            : {}),
        });
      } else if (part.state.status === "completed") streak = 0;
    }
    if (message.error !== undefined) {
      modelErrors++;
      fail();
      evidence.push({
        kind: "model",
        name: "model request",
        error: message.error.message.slice(0, MAX_EVIDENCE_CHARS),
        ...(message.error.status !== undefined
          ? { status: message.error.status }
          : {}),
      });
    }
  }
  return { total, longestStreak, modelErrors, evidence };
}

// A failed request often ends the turn, so the next user message would start from
// a clean streak. A failed last response still means the provider is unhealthy.
function modelFailedRecently(messages: Messages): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type !== "assistant") continue;
    return message.error !== undefined;
  }
  return false;
}

// Two failures in a row, or three across a turn, means the plan or the model is
// not holding up. Escalate instead of letting the turn grind on the cheaper tier.
function struggling(failures: Failures): boolean {
  return failures.longestStreak >= FAILURE_STREAK || failures.total >= FAILURE_TOTAL;
}

// The turn is struggling. Retrying the cheaper implementation route is right for
// flakes and environment hiccups; the hard model earns its cost only when the
// evidence reads as structural. Jev makes that call, and a Jev failure keeps the
// old behavior (escalate).
async function classifyFailure(
  ctx: Context,
  failures: Failures,
  context: { edited: boolean; route: PlanningRoute; retries: number },
): Promise<"retry" | "escalate"> {
  const evidence = failures.evidence
    .filter((item) => item.kind === "tool")
    .slice(-MAX_FAILURE_EVIDENCE);
  // A repeated model request failure is a provider problem, not a planning one.
  // Escalating swaps families instead of retrying the unhealthy endpoint.
  if (evidence.length === 0) return "escalate";

  try {
    const state = {
      failures: evidence.map((item) => ({
        kind: item.kind,
        name: item.name,
        error: item.error,
        ...(item.status !== undefined ? { status: item.status } : {}),
      })),
      edited_this_turn: context.edited,
      route: context.route,
      retries_granted: context.retries,
    };

    const result = await (async () => {
      for (const model of CLASSIFIERS) {
        try {
          return await ctx.experimental.generate.decisions({
            model,
            input: [{ type: "json", value: state }],
            questions: [
              {
                type: "choice",
                name: "failure",
                instructions:
                  "This turn is failing. Decide whether retrying the same implementation route is likely to succeed, or whether the plan itself is wrong and the work needs the stronger model.",
                choices: [
                  {
                    value: "retry",
                    description:
                      "Transient or local: timeout, network blip, rate limit, flaky test or command, missing binary or dependency, sandbox or permission hiccup, lint/format noise, a typo in a command or path, or an environment problem a retry can clear.",
                  },
                  {
                    value: "escalate",
                    description:
                      "Structural: the approach or plan is wrong, a cross-cutting or architectural change, concurrency or security, a data migration, a hard logic bug that survived edits, or failures that keep landing at the same point a retry cannot fix.",
                  },
                ],
              },
            ],
          });
        } catch {
          // Try the next classifier; escalation remains the final fallback.
        }
      }
    })();

    if (!result) return "escalate";
    const answer = result.answers.find((item) => item.name === "failure");
    if (answer?.type !== "choice") return "escalate";

    const escalate =
      answer.probabilities.find((item) => item.value === "escalate")
        ?.probability ?? 0;
    return escalate >= FAILURE_ESCALATE_THRESHOLD ? "escalate" : "retry";
  } catch {
    return "escalate";
  }
}

function floorQuickForPlan(
  route: PlanningRoute,
  agent: string,
): PlanningRoute {
  // An explicit Plan turn should not land on the quickest model.
  return agent === "plan" && route === "quick" ? "standard" : route;
}

function recentUserRequests(messages: Messages, userIndex: number): string[] {
  const requests: string[] = [];
  for (
    let index = userIndex - 1;
    index >= 0 && requests.length < MAX_RECENT_REQUESTS;
    index--
  ) {
    const message = messages[index];
    if (message.type !== "user" || !message.text.trim()) continue;
    requests.unshift(message.text);
  }
  return requests;
}

function mentionedIDs(prompt: string): string[] {
  return Array.from(
    new Set(
      Array.from(
        prompt.matchAll(/(?:^|\s)@([a-zA-Z0-9][\w-]*)/g),
        (match) => match[1],
      ),
    ),
  );
}

// A bare word match, so "ultrathinking" doesn't count. Same convention as
// smart-reasoning: the user pins the top route and pays no classifier latency.
function findMaxKeyword(text: string): string | undefined {
  for (const keyword of MAX_KEYWORDS) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<!\\w)${escaped}(?!\\w)`, "i").test(text)) {
      return keyword;
    }
  }
  return;
}

async function readState(
  ctx: Context,
  sessionID: string,
): Promise<RouterState | undefined> {
  try {
    return parseState(await ctx.storage.get(`jev-router:${sessionID}`));
  } catch {
    return;
  }
}

async function writeState(
  ctx: Context,
  sessionID: string,
  state: RouterState,
): Promise<void> {
  try {
    await ctx.storage.set(`jev-router:${sessionID}`, { ...state });
  } catch {
    // Routing still works without persistence; only restart/compaction recovery is lost.
  }
}

function sameState(a: RouterState | undefined, b: RouterState): boolean {
  return (
    a?.userMessageID === b.userMessageID &&
    a.phase === b.phase &&
    a.route === b.route &&
    (a.escalated === true) === (b.escalated === true) &&
    a.retryAt === b.retryAt &&
    a.retries === b.retries
  );
}

// The route tables are opaque Refs, so read the public fields defensively and
// fall back to the Ref's own serialization instead of guessing a shape.
function describeModel(model: Model.Ref): string {
  const ref = model as unknown as Record<string, unknown>;
  const provider = ref.providerID ?? ref.provider;
  const id = ref.id ?? ref.modelID ?? ref.model;
  const variant = ref.variant ?? ref.variantID ?? ref.reasoningEffort;
  if (typeof id !== "string") return JSON.stringify(ref);
  const base = typeof provider === "string" ? `${provider}/${id}` : id;
  return typeof variant === "string" ? `${base}#${variant}` : base;
}

async function appendDecision(
  ctx: Context,
  sessionID: string,
  decision: JevDecision,
): Promise<void> {
  const key = `jev-router:log:${sessionID}`;
  try {
    const list = loggedDecisions(await ctx.storage.get(key));
    // Stored as a JSON string: the storage schema rejects arrays of arbitrary
    // objects, and a string keeps the whole record readable after the fact.
    const payload = {
      json: JSON.stringify([...list, decision].slice(-DECISION_LOG_LIMIT)),
    } as unknown as NonNullable<
      Awaited<ReturnType<Context["storage"]["get"]>>
    >;
    await ctx.storage.set(key, payload);
  } catch {
    // The log is analysis-only; routing does not depend on it.
  }
}

function loggedDecisions(value: unknown): JevDecision[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).json;
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is JevDecision =>
        !!item && typeof item === "object" && !Array.isArray(item),
    );
  } catch {
    return [];
  }
}

interface Classification {
  route: PlanningRoute;
  probabilities: JevDecision["probabilities"];
  mentions: string[];
  invokedSkills: string[];
  skillListAvailable: boolean;
  /** Probability the work is irreversible/expensive-if-wrong; drove the bump. */
  highStakes: number;
  /** Set when a max keyword pinned the route without a classifier call. */
  keyword?: string;
  degraded: boolean;
}

async function classify(
  ctx: Context,
  prompt: string,
  recentRequests: string[],
  previousRoute?: Route,
): Promise<Classification> {
  const mentions = mentionedIDs(prompt);
  const fallback = (degraded: boolean): Classification => ({
    route: "standard",
    probabilities: null,
    mentions,
    invokedSkills: [],
    skillListAvailable: true,
    highStakes: 0,
    degraded,
  });

  if (!prompt.trim()) return fallback(true);

  const keyword = findMaxKeyword(prompt);
  if (keyword) {
    return {
      route: "complex",
      probabilities: null,
      mentions,
      invokedSkills: [],
      skillListAvailable: true,
      highStakes: 0,
      keyword,
      degraded: false,
    };
  }

  try {
    // Only look up skills when the prompt actually mentions something. A failed
    // lookup still blocks quick if there was a mention, because an unrecognised
    // @target may be a skill; a plain @file has no skill behind it.
    const skillList =
      mentions.length === 0
        ? undefined
        : await ctx.skill.list().catch(() => undefined);
    const skillListAvailable = mentions.length === 0 || skillList !== undefined;
    const invokedSkills = (skillList?.data ?? [])
      .filter((skill) => mentions.includes(skill.id))
      .slice(0, 3)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.description
          ? { description: skill.description.slice(0, 400) }
          : {}),
      }));

    const state = {
      request: prompt.slice(0, MAX_CLASSIFIER_INPUT),
      recent_requests: recentRequests
        .slice(-MAX_RECENT_REQUESTS)
        .map((request) => request.slice(0, 1_000)),
      invoked_skills: invokedSkills,
      previous_route: previousRoute ?? null,
    };
    const invokedSkillIds = invokedSkills.map((skill) => skill.id);

    while (
      JSON.stringify(state).length > MAX_CLASSIFIER_INPUT &&
      state.recent_requests.length > 0
    ) {
      state.recent_requests.pop();
    }
    if (JSON.stringify(state).length > MAX_CLASSIFIER_INPUT) {
      state.request = state.request.slice(0, 4_000);
    }

    const result = await (async () => {
      for (const model of CLASSIFIERS) {
        try {
          return await ctx.experimental.generate.decisions({
            model,
            input: [{ type: "json", value: state }],
            questions: [
              {
                type: "choice",
                name: "complexity",
                instructions:
                  "How much planning capability does this software engineering request need? Use the request, recent requests, invoked skill descriptions, and previous route as context.",
                choices: [
                  {
                    value: "quick",
                    description:
                      "A simple question, explanation, lookup, or tiny localized change with little planning.",
                  },
                  {
                    value: "standard",
                    description:
                      "A normal feature, bug fix, refactor, review, or skill-driven task with a clear, limited scope.",
                  },
                  {
                    value: "complex",
                    description:
                      "Subtle architecture, cross-cutting changes, migrations, concurrency, security, difficult debugging, or a broad repository audit.",
                  },
                ],
              },
              {
                type: "predicate",
                name: "high_stakes",
                instructions:
                  "Is a mistake here expensive or hard to undo: production or deployment work, security, auth, payments, data loss, migrations, or destructive operations?",
              },
            ],
          });
        } catch {
          // Try the next classifier; standard remains the final fallback.
        }
      }
    })();

    if (!result)
      return {
        ...fallback(true),
        invokedSkills: invokedSkillIds,
        skillListAvailable,
      };
    const answer = result.answers.find((item) => item.name === "complexity");
    if (answer?.type !== "choice")
      return {
        ...fallback(true),
        invokedSkills: invokedSkillIds,
        skillListAvailable,
      };

    const probability = (value: string) =>
      answer.probabilities.find((item) => item.value === value)?.probability ??
      0;

    const probabilities = {
      quick: probability("quick"),
      standard: probability("standard"),
      complex: probability("complex"),
    };

    const stakesAnswer = result.answers.find(
      (item) => item.name === "high_stakes",
    );
    const highStakes =
      stakesAnswer?.type === "predicate" ? stakesAnswer.probability : 0;

    // A real skill invocation earns a planning tier. A bare @file or @package
    // mention does not: file-scoped questions are exactly the quick case.
    const skillBlocksQuick =
      invokedSkills.length > 0 ||
      (mentions.length > 0 && !skillListAvailable);

    const requested: PlanningRoute =
      probabilities.complex >= COMPLEX_THRESHOLD
        ? "complex"
        : !skillBlocksQuick &&
            probabilities.quick >= QUICK_THRESHOLD &&
            probabilities.quick >= probabilities.standard + QUICK_MARGIN
          ? "quick"
          : "standard";

    // Stakes move the route up exactly one tier: a cheap reversible question is
    // still quick to answer, but production/security/migration work should not
    // run on it. Complex already sits at the top. Reaching complex needs a
    // structural signal too, so a risky but simple config edit stays standard.
    const route: PlanningRoute =
      highStakes >= STAKES_THRESHOLD && requested !== "complex"
        ? requested === "quick"
          ? "standard"
          : probabilities.complex >= STAKES_COMPLEX_FLOOR
            ? "complex"
            : "standard"
        : requested;

    return {
      route,
      probabilities,
      mentions,
      invokedSkills: invokedSkillIds,
      skillListAvailable,
      highStakes,
      degraded: false,
    };
  } catch {
    return fallback(true);
  }
}

async function routePrimary(
  ctx: Context,
  sessionID: string,
  agent: string,
  routes: Record<Route, Model.Ref>,
  escalation: Model.Ref = routes.complex,
  report?: (model: Model.Ref, tier: JevRoute["tier"]) => Promise<void>,
): Promise<Model.Ref> {
  const pick = async (model: Model.Ref, tier: JevRoute["tier"]) => {
    await report?.(model, tier);
    return model;
  };

  const messages = await ctx.session
    .context({ sessionID })
    .catch(() => [] as Messages);
  const userIndex = lastUserIndex(messages);
  if (userIndex < 0 || messages[userIndex].type !== "user")
    return pick(routes.standard, "standard");

  const user = messages[userIndex];
  const state = await readState(ctx, sessionID);
  const planning = agent === "plan";
  // The Plan agent may write plan files under ~/.opencode/plan; those are
  // planning artifacts, not the start of implementation.
  const edited = !planning && editedThisTurn(messages, userIndex);
  // State written for this user turn, if the router has seen it already.
  const turn = state?.userMessageID === user.id ? state : undefined;
  // The origin route survives the switch to implementation, so a complex turn
  // keeps its effort instead of dropping on the first edit. "implementation"
  // only appears in state written by an older plugin version.
  const origin: PlanningRoute | undefined =
    turn === undefined
      ? undefined
      : turn.route === "implementation"
        ? "standard"
        : turn.route;
  // Escalation is sticky for the turn: once the failures scroll out of context
  // the stored flag still holds. A fresh struggle is triaged first, so a flaky
  // command retries on the implementation route instead of burning the hard model.
  const failures = toolFailures(messages, userIndex);
  let escalated = turn?.escalated === true;
  let retryAt = turn?.retryAt;
  let retries = turn?.retries ?? 0;
  if (!escalated && struggling(failures)) {
    const seen = turn?.retryAt ?? 0;
    // New failures after the last retry are triaged again. No new failures means
    // the retry verdict still stands, and the turn keeps its route.
    if (failures.total > seen) {
      if (retries >= MAX_FAILURE_RETRIES) {
        escalated = true;
      } else {
        const verdict = await classifyFailure(ctx, failures, {
          edited,
          route: origin ?? "standard",
          retries,
        });
        if (verdict === "escalate") escalated = true;
        else {
          retryAt = failures.total;
          retries += 1;
        }
      }
    }
  }
  const retryState: Pick<RouterState, "retryAt" | "retries"> = escalated
    ? {}
    : {
        ...(retryAt !== undefined ? { retryAt } : {}),
        ...(retries > 0 ? { retries } : {}),
      };
  const implementing =
    !planning &&
    (edited || (turn !== undefined && turn.phase === "implementation"));

  if (implementing) {
    const next: RouterState = {
      userMessageID: user.id,
      phase: "implementation",
      route: origin ?? "standard",
      ...(escalated ? { escalated: true } : {}),
      ...retryState,
    };
    if (!sameState(turn, next)) {
      await writeState(ctx, sessionID, next);
      const model = escalated
        ? escalation
        : origin === "complex"
          ? routes.complex
          : routes.implementation;
      await appendDecision(ctx, sessionID, {
        ts: Date.now(),
        sessionID,
        userMessageID: user.id,
        routerVersion: ROUTER_VERSION,
        agent,
        kind: "primary",
        phase: "implementation",
        route: origin ?? "standard",
        probabilities: null,
        mentions: [],
        invokedSkills: [],
        skillListAvailable: true,
        previousRoute: origin ?? null,
        resolvedModel: describeModel(model),
        tier: escalated ? "escalated" : "implementation",
        escalated,
        edited,
        ...(retries > 0 ? { retries } : {}),
      });
    }
    if (escalated) return pick(escalation, "escalated");
    return origin === "complex"
      ? pick(routes.complex, "implementation")
      : pick(routes.implementation, "implementation");
  }

  const classification = origin
    ? undefined
    : await classify(
        ctx,
        user.text,
        recentUserRequests(messages, userIndex),
        state?.route,
      );
  const route = floorQuickForPlan(origin ?? classification!.route, agent);
  const next: RouterState = {
    userMessageID: user.id,
    phase: "planning",
    route,
    ...(escalated ? { escalated: true } : {}),
    ...retryState,
  };
  if (!sameState(turn, next)) {
    await writeState(ctx, sessionID, next);
    await appendDecision(ctx, sessionID, {
      ts: Date.now(),
      sessionID,
      userMessageID: user.id,
      routerVersion: ROUTER_VERSION,
      agent,
      kind: "primary",
      phase: "planning",
      route,
      probabilities: classification?.probabilities ?? null,
      mentions: classification?.mentions ?? [],
      invokedSkills: classification?.invokedSkills ?? [],
      skillListAvailable: classification?.skillListAvailable ?? true,
      previousRoute: state?.route ?? null,
      resolvedModel: describeModel(escalated ? escalation : routes[route]),
      tier: escalated ? "escalated" : route,
      escalated,
      edited,
      ...(classification?.keyword ? { keyword: classification.keyword } : {}),
      ...(classification !== undefined && classification.highStakes > 0
        ? { stakes: classification.highStakes }
        : {}),
      ...(classification?.degraded ? { degraded: true } : {}),
      ...(retries > 0 ? { retries } : {}),
    });
  }
  return escalated ? pick(escalation, "escalated") : pick(routes[route], route);
}

async function routeSubagent(
  ctx: Context,
  sessionID: string,
  agent: string,
  report?: (model: Model.Ref, tier: JevRoute["tier"]) => Promise<void>,
): Promise<Model.Ref> {
  const pick = async (model: Model.Ref, tier: JevRoute["tier"]) => {
    await report?.(model, tier);
    return model;
  };

  // Explore is read-only search; no classifier round-trip is worth it there.
  if (agent === "explore") {
    await appendDecision(ctx, sessionID, {
      ts: Date.now(),
      sessionID,
      userMessageID: "",
      routerVersion: ROUTER_VERSION,
      agent,
      kind: "subagent",
      phase: "planning",
      route: "quick",
      probabilities: null,
      mentions: [],
      invokedSkills: [],
      skillListAvailable: true,
      previousRoute: null,
      resolvedModel: describeModel(SUBAGENT_ROUTES.quick),
      tier: "quick",
      escalated: false,
    });
    return pick(SUBAGENT_ROUTES.quick, "quick");
  }

  const messages = await ctx.session
    .context({ sessionID })
    .catch(() => [] as Messages);
  const userIndex = lastUserIndex(messages);
  if (userIndex < 0 || messages[userIndex].type !== "user")
    return pick(SUBAGENT_ROUTES.standard, "standard");

  const user = messages[userIndex];
  const state = await readState(ctx, sessionID);
  const failures = toolFailures(messages, userIndex);
  // No human is watching a subagent, and a free model request can fail on a
  // per-model rate limit, so one failed request is enough to switch families.
  const failed =
    (state?.userMessageID === user.id && state.escalated === true) ||
    failures.modelErrors > 0 ||
    modelFailedRecently(messages) ||
    struggling(failures);

  if (state?.userMessageID === user.id && state.route !== "implementation") {
    const route = state.route;
    const next: RouterState = {
      userMessageID: user.id,
      phase: "planning",
      route,
      ...(failed ? { escalated: true } : {}),
    };
    if (!sameState(state, next)) {
      await writeState(ctx, sessionID, next);
      await appendDecision(ctx, sessionID, {
        ts: Date.now(),
        sessionID,
        userMessageID: user.id,
        routerVersion: ROUTER_VERSION,
        agent,
        kind: "subagent",
        phase: "planning",
        route,
        probabilities: null,
        mentions: [],
        invokedSkills: [],
        skillListAvailable: true,
        previousRoute: state.route ?? null,
        resolvedModel: describeModel(
          failed ? SUBAGENT_ESCALATION : SUBAGENT_ROUTES[route],
        ),
        tier: failed ? "escalated" : route,
        escalated: failed,
      });
    }
    return failed
      ? pick(SUBAGENT_ESCALATION, "escalated")
      : pick(SUBAGENT_ROUTES[route], route);
  }

  const classification = await classify(ctx, user.text, []);
  const route = classification.route;
  await writeState(ctx, sessionID, {
    userMessageID: user.id,
    phase: "planning",
    route,
    ...(failed ? { escalated: true } : {}),
  });
  await appendDecision(ctx, sessionID, {
    ts: Date.now(),
    sessionID,
    userMessageID: user.id,
    routerVersion: ROUTER_VERSION,
    agent,
    kind: "subagent",
    phase: "planning",
    route,
    probabilities: classification.probabilities,
    mentions: classification.mentions,
    invokedSkills: classification.invokedSkills,
    skillListAvailable: classification.skillListAvailable,
    previousRoute: state?.route ?? null,
    resolvedModel: describeModel(
      failed ? SUBAGENT_ESCALATION : SUBAGENT_ROUTES[route],
    ),
    tier: failed ? "escalated" : route,
    escalated: failed,
    ...(classification.keyword ? { keyword: classification.keyword } : {}),
    ...(classification.highStakes > 0 ? { stakes: classification.highStakes } : {}),
    ...(classification.degraded ? { degraded: true } : {}),
  });
  return failed
    ? pick(SUBAGENT_ESCALATION, "escalated")
    : pick(SUBAGENT_ROUTES[route], route);
}

// The four virtual models exist only so OpenCode can select them as the
// session's visible model. The resolve hook below rewrites every request to a
// real model, so their own settings are never sent to a provider. Registering
// them from the plugin keeps opencode.json free of model bookkeeping; the only
// config left is the plugin itself and the session default (set below).
const VIRTUAL_MODELS = [
  {
    providerID: "opencode-go",
    id: "jev-auto",
    modelID: "hy4-flash-free",
    name: "Jev Auto (Go)",
    settings: { reasoningEffort: "high" },
    context: 1_048_576,
  },
  {
    providerID: "opencode",
    id: "jev-lite",
    modelID: "deepseek-v4.1-flash-free",
    name: "Jev Lite (Free)",
    settings: { reasoningEffort: "high" },
    context: 200_000,
  },
  {
    providerID: "opencode",
    id: "jev-sub",
    modelID: "hy4-flash-free",
    name: "Jev Sub (Free)",
    settings: { reasoningEffort: "high" },
    context: 200_000,
  },
  {
    providerID: "claude-agent",
    id: "jev-claude",
    modelID: "sonnet",
    name: "Jev Claude (Pro)",
    settings: { effort: "medium" },
    context: 1_000_000,
  },
] as const;

export default Plugin.define({
  id: "opencode-pilot",
  async setup(ctx) {
    const latest = new Map<string, JevRoute>();

    // Editors cannot create a provider, only models under one that is already
    // available. `list()` only returns models from available providers, which
    // makes it the availability check (provider templates are not enough). If a
    // provider is not available (for example Claude Pro without a
    // subscription), registration is skipped instead of failing setup.
    await ctx.model.transform((editor) => {
      for (const entry of VIRTUAL_MODELS) {
        if (editor.list(entry.providerID).length === 0) continue;
        editor.update(entry.providerID, entry.id, (model) => {
          Object.assign(
            model,
            Model.Info.default(
              Provider.ID.make(entry.providerID),
              Model.ID.make(entry.id),
            ),
          );
          model.modelID = Model.ID.make(entry.modelID);
          model.name = entry.name;
          model.settings = { ...entry.settings } as typeof model.settings;
          model.capabilities = {
            ...model.capabilities,
            tools: true,
            input: [
              "text",
              "image",
              ...(entry.providerID === "claude-agent" ? ["pdf"] : []),
            ],
            output: ["text"],
          };
          model.limit = { context: entry.context, output: 65_536 };
        });
      }
      editor.default.set("opencode-go", "jev-auto");
    });

    // Put every visible subagent on the free jev-sub router, including
    // custom project subagents that pinned another model in their config.
    await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        if (agent.mode !== "subagent" || agent.hidden) continue;
        editor.update(agent.id, (draft) => {
          draft.model = SUBAGENT_MODEL;
        });
      }
    });

    const registration = await ctx.rpc.register(JevStatus, {
      get: async (input) => {
        const sessionID =
          typeof input === "object" &&
          input !== null &&
          "sessionID" in input &&
          typeof input.sessionID === "string"
            ? input.sessionID
            : undefined;
        const key = sessionID
          ? `jev-router:latest:${sessionID}`
          : "jev-router:latest";
        const current = await ctx.storage.get(key).catch(() => undefined);
        return { route: (current as JevRoute | undefined) ?? null };
      },
      decisions: async (input) => {
        const sessionID =
          typeof input === "object" && input !== null && "sessionID" in input
            ? input.sessionID
            : undefined;
        if (typeof sessionID !== "string" || !sessionID)
          return { decisions: [] };
        const current = await ctx.storage
          .get(`jev-router:log:${sessionID}`)
          .catch(() => undefined);
        return {
          decisions: loggedDecisions(current) as unknown as Record<
            string,
            unknown
          >[],
        };
      },
    });

    const report = async (
      model: { id: string },
      tier: JevRoute["tier"],
      sessionID: string,
    ) => {
      const route: JevRoute = {
        sessionID,
        model: model.id,
        tier,
        updated: Date.now(),
      };
      latest.set(sessionID, route);
      await ctx.storage
        .set(`jev-router:latest:${sessionID}`, { ...route })
        .catch(() => undefined);
      await ctx.storage
        .set("jev-router:latest", { ...route })
        .catch(() => undefined);
      await registration.events
        .emit("changed", { ...route })
        .catch(() => undefined);
    };

    for (const providerID of [
      "opencode-go",
      "opencode",
      "claude-agent",
    ] as const) {
      await ctx.session.hook(
        "experimental.model.resolve",
        async (event) => {
          if (isSubagentModel(event.model.providerID, event.model.id)) {
            if (event.kind !== "primary") {
              const model = SUBAGENT_AUXILIARY[event.kind];
              event.model = model;
              await report(model, "auxiliary", event.sessionID);
              return;
            }
            event.model = await routeSubagent(
              ctx,
              event.sessionID,
              event.agent,
              (model, tier) => report(model, tier, event.sessionID),
            );
            return;
          }

          const routes = routesFor(event.model.providerID, event.model.id);
          if (!routes) return;
          const auxiliary = auxiliaryFor(event.model.providerID);

          if (event.kind === "title") {
            event.model = auxiliary.title;
            await report(event.model, "auxiliary", event.sessionID);
            return;
          }
          if (event.kind === "compaction") {
            event.model = auxiliary.compaction;
            await report(event.model, "auxiliary", event.sessionID);
            return;
          }
          if (event.kind === "generate") {
            event.model = auxiliary.generate;
            await report(event.model, "auxiliary", event.sessionID);
            return;
          }

          event.model = await routePrimary(
            ctx,
            event.sessionID,
            event.agent,
            routes,
            providerID === "opencode" ? LITE_ESCALATION : routes.complex,
            (model, tier) => report(model, tier, event.sessionID),
          );
        },
        { providerID },
      );
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.model.selected"],
          signal: controller.signal,
        })) {
          if (event.type !== "session.model.selected") continue;
          const { sessionID, model } = event.data;
          if (routesFor(model.providerID, model.id)) continue;
          if (isSubagentModel(model.providerID, model.id)) continue;
          await report(model, "manual", sessionID);
        }
      } catch {
        // The event stream is best-effort; routing does not depend on it.
      }
    })();

    return () => controller.abort();
  },
});
