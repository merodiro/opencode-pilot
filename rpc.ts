import { Rpc } from "@opencode/plugin/rpc";

export interface JevRoute {
  sessionID: string;
  model: string;
  tier:
    | "quick"
    | "standard"
    | "complex"
    | "implementation"
    | "escalated"
    | "auxiliary"
    | "manual";
  updated: number;
}

export interface JevDecision {
  ts: number;
  sessionID: string;
  userMessageID: string;
  routerVersion: string;
  agent: string;
  kind: "primary" | "subagent";
  phase: "planning" | "implementation";
  route: "quick" | "standard" | "complex";
  probabilities: { quick: number; standard: number; complex: number } | null;
  mentions: string[];
  invokedSkills: string[];
  skillListAvailable: boolean;
  previousRoute: string | null;
  resolvedModel: string;
  tier: JevRoute["tier"];
  escalated: boolean;
  edited?: boolean;
  /** Max keyword that pinned the route without a classifier call. */
  keyword?: string;
  /** High-stakes probability when the stakes bump raised the route. */
  stakes?: number;
  /** Retries granted this turn when the record came from failure triage. */
  retries?: number;
  degraded?: boolean;
}

export const JevStatus = Rpc.define({
  id: "jev-router.status",
  methods: {
    get: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          route: {
            oneOf: [
              {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  model: { type: "string" },
                  tier: { type: "string" },
                  updated: { type: "number" },
                },
                required: ["sessionID", "model", "tier", "updated"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
        required: ["route"],
        additionalProperties: false,
      },
    },
    decisions: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: { type: "object" },
          },
        },
        required: ["decisions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          model: { type: "string" },
          tier: { type: "string" },
          updated: { type: "number" },
        },
        required: ["sessionID", "model", "tier", "updated"],
      },
    },
  },
});
