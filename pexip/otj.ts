import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  extractId,
  pexipApi,
  type PexipGlobalArgs,
  PexipGlobalArgsSchema,
  pexipListAll,
  pexipMethods,
  sanitizeId,
  STATUS_BASE,
} from "./_client.ts";

/**
 * Pexip Infinity One-Touch Join (OTJ) Model
 *
 * Manages the OTJ subsystem that connects Pexip to room system calendars
 * for OBTP (One Button To Push) on Cisco and OTD (One Touch Dial) on Poly.
 *
 * OTJ polls calendar systems (Exchange, O365 Graph, Google Workspace) for
 * meetings containing video URIs, then pushes dial buttons to endpoints.
 *
 * Capacity: up to 4,000 room resource calendars, 5 conf nodes per location.
 */

const OtjEndpointSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    alias: z.string().optional(),
    endpoint_group: z.string().optional(),
    protocol: z.string().optional(),
    ip_address: z.string().optional(),
    calendar_id: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const OtjEndpointGroupSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    integration: z.string().optional(),
  })
  .passthrough();

const OtjProfileSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    system_location: z.string().optional(),
  })
  .passthrough();

const OtjMeetingProcessingRuleSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    priority: z.number().optional(),
    match_string: z.string().optional(),
    replace_string: z.string().optional(),
    meeting_type: z.string().optional(),
    enabled: z.boolean().optional(),
    mjx_integration: z.string().optional(),
    default_processing_enabled: z.boolean().optional(),
    legacyRegex: z.boolean().optional(),
    deprecationWarnings: z.array(z.string()).optional(),
  })
  .passthrough();

const MeetingRuleAuditSchema = z.object({
  total: z.number(),
  legacyRegexCount: z.number(),
  legacyRegexRules: z.array(z.string()),
});

const CalendarDeploymentSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const OtjMeetingStatusSchema = z
  .object({
    id: z.string().optional(),
    subject: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    endpoint_name: z.string().optional(),
    dial_string: z.string().optional(),
    meeting_type: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

/**
 * OTJ meeting processing rule `meeting_type` values, exactly as Pexip's own
 * Terraform provider validates them (`stringvalidator.OneOf` on
 * `meeting_type` in
 * https://github.com/pexip/terraform-provider-infinity/blob/master/internal/provider/resource_infinity_mjx_meeting_processing_rule.go).
 * Infinity v41 introduced Regex RE2 (`regex_re2`) and deprecated the legacy
 * Regex type (`regex`), which the API still accepts (docs.pexip.com, v41
 * release notes).
 */
export const LEGACY_REGEX_MEETING_TYPE = "regex";
export const RE2_REGEX_MEETING_TYPE = "regex_re2";

export const MEETING_TYPES = [
  "pexipinfinity",
  "pexipservice",
  "teams",
  "teamssipguestjoin",
  "polyteamsbody",
  "ciscoteamsbody",
  "pexipserviceteamsbody",
  "pexipinfinityteamsbody",
  "hangouts",
  "googlemeetsipguestjoin",
  "s4b",
  "polys4bbody",
  "webex",
  "zoom",
  "gotomeeting",
  "domain",
  LEGACY_REGEX_MEETING_TYPE,
  RE2_REGEX_MEETING_TYPE,
  "custom",
] as const;

export type MeetingType = (typeof MEETING_TYPES)[number];

/**
 * Strings earlier builds of this model offered. The API never accepted them
 * (every one was a 400), so they are kept only as aliases for the real value.
 */
export const MEETING_TYPE_ALIASES: Record<string, MeetingType> = {
  pexip: "pexipinfinity",
  skype_for_business: "s4b",
  google_meet: "hangouts",
  google_meet_sip_guest_join: "googlemeetsipguestjoin",
  other: "custom",
};

export const DEFAULT_MEETING_TYPE: MeetingType = "pexipinfinity";

const MeetingTypeArg = z.enum([
  ...MEETING_TYPES,
  ...(Object.keys(MEETING_TYPE_ALIASES) as [string, ...string[]]),
]);

/** Map an accepted argument value (real or alias) to the API's value. */
export function normalizeMeetingType(value: string): MeetingType {
  if ((MEETING_TYPES as readonly string[]).includes(value)) {
    return value as MeetingType;
  }
  const mapped = MEETING_TYPE_ALIASES[value];
  if (!mapped) throw new Error(`Unknown OTJ meeting type: ${value}`);
  return mapped;
}

/**
 * Teams hosts checked in custom match strings. Both are checked; this does
 * not assert which one current invitations use.
 */
const TEAMS_HOSTS = ["teams.microsoft.com", "teams.cloud.microsoft"];

export function isLegacyRegexRule(rule: Record<string, unknown>): boolean {
  return rule.meeting_type === LEGACY_REGEX_MEETING_TYPE;
}

/**
 * The Teams host a match string covers when it covers only one of the two. Regex
 * escapes (`teams\.microsoft\.com`) are unescaped before the comparison.
 */
function teamsHostGap(matchString: string): string | undefined {
  const plain = matchString.replace(/\\\./g, ".").toLowerCase();
  const hit = TEAMS_HOSTS.filter((h) => plain.includes(h));
  if (hit.length !== 1) return undefined;
  return hit[0];
}

/**
 * A rule as stored in the `meetingRule` spec: the API object plus the
 * derived `legacyRegex` flag and deprecation warnings. Every method that
 * writes a listed rule goes through this so the stored shape never depends
 * on which method wrote it last.
 */
export function enrichMeetingRule(
  rule: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...rule,
    legacyRegex: isLegacyRegexRule(rule),
    deprecationWarnings: meetingRuleWarnings(
      String(rule.meeting_type ?? ""),
      String(rule.match_string ?? ""),
    ),
  };
}

/** Deprecation warnings for a rule about to be written; empty when clean. */
export function meetingRuleWarnings(
  meetingType: string,
  matchString: string,
): string[] {
  const warnings: string[] = [];
  if (meetingType === LEGACY_REGEX_MEETING_TYPE) {
    warnings.push(
      `Meeting type '${LEGACY_REGEX_MEETING_TYPE}' is deprecated as of Pexip Infinity v41; use '${RE2_REGEX_MEETING_TYPE}' instead`,
    );
  }
  const host = teamsHostGap(matchString);
  if (host) {
    const other = TEAMS_HOSTS.find((h) => h !== host);
    warnings.push(
      `Match string references ${host} but not ${other}; Teams links can use either host, so check whether the pattern should match both`,
    );
  }
  return warnings;
}

const MJX_INTEGRATION_PATH = `${CONFIG_BASE}/mjx_integration/`;
const MEETING_RULE_PATH = `${CONFIG_BASE}/mjx_meeting_processing_rule/`;

/**
 * Resolve an OTJ profile to the resource URI the rule's `mjx_integration`
 * field takes. A full `/api/admin/configuration/v1/mjx_integration/<id>/`
 * URI passes through; anything else is looked up by exact profile name.
 */
export async function resolveProfileUri(
  profile: string,
  g: PexipGlobalArgs,
): Promise<string> {
  if (
    /^\/api\/admin\/configuration\/v1\/mjx_integration\/\d+\/?$/.test(profile)
  ) {
    return profile.endsWith("/") ? profile : `${profile}/`;
  }
  const profiles = await pexipListAll(MJX_INTEGRATION_PATH, g, {
    name: profile,
  });
  const match = profiles.find((p) => p.name === profile);
  if (!match?.resource_uri) {
    throw new Error(
      `OTJ profile not found: '${profile}'. Pass an existing profile name (see listProfiles) or its full resource URI (${MJX_INTEGRATION_PATH}<id>/)`,
    );
  }
  return match.resource_uri as string;
}

/** Find exactly one meeting rule by id or exact name; refuse ambiguity. */
async function findMeetingRule(
  g: PexipGlobalArgs,
  name: string,
  id?: number,
): Promise<Record<string, unknown>> {
  if (id !== undefined) {
    const rule = (await pexipApi(`${MEETING_RULE_PATH}${id}/`, g)) as
      | Record<string, unknown>
      | null;
    if (!rule) throw new Error(`Meeting processing rule not found: id ${id}`);
    if (rule.name !== name) {
      throw new Error(
        `Meeting processing rule ${id} is named '${
          String(rule.name)
        }', not '${name}'; refusing to act on a mismatched rule`,
      );
    }
    return rule;
  }
  const rules = await pexipListAll(MEETING_RULE_PATH, g, { name });
  const matches = rules.filter((r) => r.name === name);
  if (matches.length === 0) {
    throw new Error(`Meeting processing rule not found: ${name}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} meeting processing rules are named '${name}' (ids ${
        matches.map((r) => extractId(r.resource_uri as string)).join(", ")
      }); pass id to choose one`,
    );
  }
  return matches[0];
}

/**
 * `@dougschaefer/pexip-otj` model — One-Touch Join surface for Pexip
 * Infinity over the v39 management API. OTJ is the calendar-driven
 * room-system join path that turns Exchange, Graph, and Google
 * Calendar invitations into Pexip-mediated joins on Cisco, Poly, and
 * other SIP/H.323 endpoints. Endpoint and endpoint-group CRUD
 * register the room systems that will receive OTJ buttons. Profile
 * CRUD defines the join behavior (target service, fallback aliases,
 * dial protocol). Meeting-rule CRUD encodes the alias-extraction
 * regex pipeline applied to invitation bodies. Calendar-deployment
 * methods (configureGraphDeployment, configureExchangeDeployment,
 * configureGoogleDeployment) wire the upstream calendar source per
 * tenant. listMeetings and getEndpointStatus surface the resolved
 * meetings and per-endpoint state for operational dashboards.
 * inventory rolls everything together for audit. Mutations affect
 * how live room systems behave when users press Join — coordinate
 * with end-user comms.
 */
export const model = {
  type: "@dougschaefer/pexip-otj",
  version: "2026.10.08.1",
  globalArguments: PexipGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Pexip meeting_type values, Regex RE2, mjx_integration on meeting rules, rule update/delete; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.08.1",
      description:
        "Version bump alongside configureSyslog proto_format and log-category options; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    endpoint: {
      description: "OTJ endpoint (room system with calendar integration)",
      schema: OtjEndpointSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    endpointGroup: {
      description: "OTJ endpoint group (logical collection of rooms)",
      schema: OtjEndpointGroupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    profile: {
      description: "OTJ integration profile",
      schema: OtjProfileSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    meetingRule: {
      description: "OTJ meeting processing rule (URI pattern matching)",
      schema: OtjMeetingProcessingRuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    meetingRuleAudit: {
      description:
        "Meeting-rule audit summary (total rules, legacy Regex count and names)",
      schema: MeetingRuleAuditSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    calendarDeployment: {
      description: "Calendar system deployment (Exchange, Graph, Google)",
      schema: CalendarDeploymentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    meeting: {
      description: "Active OTJ meeting status",
      schema: OtjMeetingStatusSchema,
      lifetime: "1h" as const,
      garbageCollection: 50,
    },
  },
  methods: pexipMethods()({
    // --- Endpoints ---

    listEndpoints: {
      description:
        "List all OTJ endpoints (room systems with calendar integration).",
      arguments: z.object({
        groupName: z.string().optional().describe(
          "Filter by endpoint group name",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.groupName) params.endpoint_group__name = args.groupName;

        const endpoints = await pexipListAll(
          `${CONFIG_BASE}/mjx_endpoint/`,
          g,
          params,
        );
        context.logger.info("Found {count} OTJ endpoints", {
          count: endpoints.length,
        });

        const handles = [];
        for (const ep of endpoints) {
          handles.push(
            await context.writeResource(
              "endpoint",
              sanitizeId(ep.name as string),
              ep,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    createEndpoint: {
      description: "Register a room system endpoint for OTJ (OBTP/OTD).",
      arguments: z.object({
        name: z.string().describe("Endpoint name (e.g., room display name)"),
        alias: z.string().describe("SIP/H.323 alias to dial the endpoint"),
        endpointGroupUri: z.string().describe(
          "Resource URI of the endpoint group",
        ),
        calendarId: z.string().optional().describe(
          "Calendar resource email/ID",
        ),
        protocol: z.enum(["sip", "h323", "cisco", "poly"]).optional().default(
          "sip",
        ),
        ipAddress: z.string().optional().describe(
          "Direct IP for Cisco xAPI push",
        ),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          alias: args.alias,
          endpoint_group: args.endpointGroupUri,
          protocol: args.protocol,
          enabled: args.enabled,
        };
        if (args.calendarId) body.calendar_id = args.calendarId;
        if (args.ipAddress) body.ip_address = args.ipAddress;

        await pexipApi(`${CONFIG_BASE}/mjx_endpoint/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created OTJ endpoint {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    deleteEndpoint: {
      description: "Remove an OTJ endpoint.",
      arguments: z.object({ name: z.string() }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const eps = await pexipListAll(`${CONFIG_BASE}/mjx_endpoint/`, g, {
          name: args.name,
        });
        const ep = eps.find((e) => e.name === args.name);
        if (!ep) throw new Error(`OTJ endpoint not found: ${args.name}`);
        const epId = extractId(ep.resource_uri as string);
        await pexipApi(`${CONFIG_BASE}/mjx_endpoint/${epId}/`, g, {
          method: "DELETE",
        });
        context.logger.info("Deleted OTJ endpoint {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- Endpoint groups ---

    listEndpointGroups: {
      description: "List OTJ endpoint groups.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const groups = await pexipListAll(
          `${CONFIG_BASE}/mjx_endpoint_group/`,
          g,
        );
        context.logger.info("Found {count} OTJ endpoint groups", {
          count: groups.length,
        });
        const handles = [];
        for (const grp of groups) {
          handles.push(
            await context.writeResource(
              "endpointGroup",
              sanitizeId(grp.name as string),
              grp,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    createEndpointGroup: {
      description: "Create an OTJ endpoint group.",
      arguments: z.object({
        name: z.string().describe("Group name (e.g., client code or building)"),
        description: z.string().optional(),
        integrationUri: z.string().optional().describe(
          "Resource URI of the OTJ profile",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };
        if (args.description) body.description = args.description;
        if (args.integrationUri) body.integration = args.integrationUri;

        await pexipApi(`${CONFIG_BASE}/mjx_endpoint_group/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created OTJ endpoint group {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    // --- Profiles ---

    listProfiles: {
      description: "List OTJ integration profiles.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const profiles = await pexipListAll(
          `${CONFIG_BASE}/mjx_integration/`,
          g,
        );
        context.logger.info("Found {count} OTJ profiles", {
          count: profiles.length,
        });
        const handles = [];
        for (const p of profiles) {
          handles.push(
            await context.writeResource(
              "profile",
              sanitizeId(p.name as string),
              p,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    createProfile: {
      description: "Create an OTJ integration profile.",
      arguments: z.object({
        name: z.string().describe("Profile name"),
        description: z.string().optional(),
        systemLocationUri: z.string().optional().describe(
          "System location resource URI",
        ),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          enabled: args.enabled,
        };
        if (args.description) body.description = args.description;
        if (args.systemLocationUri) {
          body.system_location = args.systemLocationUri;
        }

        await pexipApi(`${CONFIG_BASE}/mjx_integration/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created OTJ profile {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- Meeting processing rules ---

    listMeetingRules: {
      description:
        "List OTJ meeting processing rules (URI pattern matching for dial strings). Each written rule carries a legacyRegex flag and its deprecationWarnings, and a meetingRuleAudit record holds the legacy-Regex count.",
      arguments: z.object({
        legacyRegexOnly: z.boolean().optional().default(false).describe(
          "Only return rules still using the deprecated legacy Regex meeting type",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rules = await pexipListAll(MEETING_RULE_PATH, g);
        context.logger.info("Found {count} meeting processing rules", {
          count: rules.length,
        });
        const legacy = rules.filter(isLegacyRegexRule);
        if (legacy.length > 0) {
          // info, not warning: swamp hides warning-level lines without -v.
          context.logger.info(
            "{count} meeting processing rules use the deprecated Regex meeting type; migrate them to Regex RE2 with updateMeetingRule",
            { count: legacy.length },
          );
        }
        const handles = [];
        for (const r of args.legacyRegexOnly ? legacy : rules) {
          handles.push(
            await context.writeResource(
              "meetingRule",
              sanitizeId(r.name as string),
              enrichMeetingRule(r),
            ),
          );
        }
        handles.push(
          await context.writeResource("meetingRuleAudit", "meeting-rules", {
            total: rules.length,
            legacyRegexCount: legacy.length,
            legacyRegexRules: legacy.map((r) => r.name as string),
          }),
        );
        return { dataHandles: handles };
      },
    },

    createMeetingRule: {
      description:
        "Create an OTJ meeting processing rule bound to an OTJ profile (mjx_integration).",
      arguments: z.object({
        name: z.string().describe("Rule name"),
        profile: z.string().describe(
          "OTJ profile the rule belongs to: the profile name (resolved via mjx_integration) or its full resource URI",
        ),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(200).optional().default(100)
          .describe("Rules are checked in ascending priority order (1-200)"),
        matchString: z.string().optional().describe(
          "Regex that finds the string to extract from the invitation",
        ),
        replaceString: z.string().optional().describe(
          "Regex replacement that turns the match into the alias to dial",
        ),
        meetingType: MeetingTypeArg.optional().default(DEFAULT_MEETING_TYPE)
          .describe(
            "Pexip meeting_type value; the old pexip, skype_for_business, google_meet, google_meet_sip_guest_join and other strings are accepted as aliases",
          ),
        enabled: z.boolean().optional().default(true),
        defaultProcessingEnabled: z.boolean().optional().default(true)
          .describe(
            "Apply the default processing rules for this meeting type (default_processing_enabled)",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const meetingType = normalizeMeetingType(args.meetingType);
        if (meetingType !== args.meetingType) {
          context.logger.info(
            "Meeting type alias '{alias}' mapped to '{value}'",
            { alias: args.meetingType, value: meetingType },
          );
        }
        const warnings = meetingRuleWarnings(
          meetingType,
          args.matchString ?? "",
        );
        for (const w of warnings) context.logger.info(w);

        const mjxIntegration = await resolveProfileUri(args.profile, g);
        // Field names from MjxMeetingProcessingRuleCreateRequest in
        // https://github.com/pexip/go-infinity-sdk/blob/master/config/mjx_meeting_processing_rule_model.go
        const body: Record<string, unknown> = {
          name: args.name,
          priority: args.priority,
          meeting_type: meetingType,
          mjx_integration: mjxIntegration,
          enabled: args.enabled,
          default_processing_enabled: args.defaultProcessingEnabled,
        };
        if (args.description) body.description = args.description;
        if (args.matchString) body.match_string = args.matchString;
        if (args.replaceString) body.replace_string = args.replaceString;

        await pexipApi(MEETING_RULE_PATH, g, { method: "POST", body });
        context.logger.info("Created meeting processing rule {name}", {
          name: args.name,
        });
        const handle = await context.writeResource(
          "meetingRule",
          sanitizeId(args.name),
          {
            ...body,
            legacyRegex: meetingType === LEGACY_REGEX_MEETING_TYPE,
            deprecationWarnings: warnings,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    updateMeetingRule: {
      description:
        "Update an OTJ meeting processing rule in place (PATCH) — e.g. migrate a legacy Regex rule to Regex RE2.",
      arguments: z.object({
        name: z.string().describe("Exact name of the rule to update"),
        id: z.number().int().optional().describe(
          "Rule id, required when several rules share the name",
        ),
        newName: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(200).optional(),
        matchString: z.string().optional(),
        replaceString: z.string().optional(),
        meetingType: MeetingTypeArg.optional(),
        enabled: z.boolean().optional(),
        defaultProcessingEnabled: z.boolean().optional(),
        profile: z.string().optional().describe(
          "Move the rule to another OTJ profile (name or resource URI)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rule = await findMeetingRule(g, args.name, args.id);
        const ruleId = extractId(rule.resource_uri as string);

        const body: Record<string, unknown> = {};
        if (args.newName !== undefined) body.name = args.newName;
        if (args.description !== undefined) {
          body.description = args.description;
        }
        if (args.priority !== undefined) body.priority = args.priority;
        if (args.matchString !== undefined) {
          body.match_string = args.matchString;
        }
        if (args.replaceString !== undefined) {
          body.replace_string = args.replaceString;
        }
        if (args.meetingType !== undefined) {
          body.meeting_type = normalizeMeetingType(args.meetingType);
        }
        if (args.enabled !== undefined) body.enabled = args.enabled;
        if (args.defaultProcessingEnabled !== undefined) {
          body.default_processing_enabled = args.defaultProcessingEnabled;
        }
        if (args.profile !== undefined) {
          body.mjx_integration = await resolveProfileUri(args.profile, g);
        }
        if (Object.keys(body).length === 0) {
          throw new Error("updateMeetingRule: no fields to update");
        }

        const merged = { ...rule, ...body };
        const warnings = meetingRuleWarnings(
          String(merged.meeting_type ?? ""),
          String(merged.match_string ?? ""),
        );
        for (const w of warnings) context.logger.info(w);

        await pexipApi(`${MEETING_RULE_PATH}${ruleId}/`, g, {
          method: "PATCH",
          body,
        });
        context.logger.info(
          "Updated meeting processing rule '{name}': {fields}",
          {
            name: args.name,
            fields: Object.keys(body).join(", "),
          },
        );
        const handle = await context.writeResource(
          "meetingRule",
          sanitizeId(String(merged.name)),
          {
            ...merged,
            legacyRegex: isLegacyRegexRule(merged),
            deprecationWarnings: warnings,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    deleteMeetingRule: {
      description:
        "Delete one OTJ meeting processing rule, matched by exact name (and id when names collide). dryRun resolves the rule without deleting it.",
      arguments: z.object({
        name: z.string().describe("Exact name of the rule to delete"),
        id: z.number().int().optional().describe(
          "Rule id, required when several rules share the name",
        ),
        dryRun: z.boolean().optional().default(false).describe(
          "Resolve and report the rule without deleting it",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rule = await findMeetingRule(g, args.name, args.id);
        const ruleId = extractId(rule.resource_uri as string);
        if (args.dryRun) {
          context.logger.info(
            "Dry run: would delete meeting processing rule '{name}' (id {id})",
            { name: args.name, id: ruleId },
          );
          return { dataHandles: [] };
        }
        await pexipApi(`${MEETING_RULE_PATH}${ruleId}/`, g, {
          method: "DELETE",
        });
        context.logger.info(
          "Deleted meeting processing rule '{name}' (id {id})",
          {
            name: args.name,
            id: ruleId,
          },
        );
        return { dataHandles: [] };
      },
    },

    // --- Calendar deployments ---

    listCalendarDeployments: {
      description:
        "List all calendar system deployments (Exchange, O365 Graph, Google).",
      arguments: z.object({
        type: z
          .enum(["exchange", "graph", "google"])
          .optional()
          .describe("Filter by calendar type"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const handles = [];

        const types = args.type ? [args.type] : ["exchange", "graph", "google"];

        for (const t of types) {
          const path = t === "exchange"
            ? `${CONFIG_BASE}/mjx_exchange_deployment/`
            : t === "graph"
            ? `${CONFIG_BASE}/mjx_graph_deployment/`
            : `${CONFIG_BASE}/mjx_google_deployment/`;

          const deployments = await pexipListAll(path, g);
          for (const d of deployments) {
            handles.push(
              await context.writeResource(
                "calendarDeployment",
                sanitizeId(`${t}-${d.name}`),
                { ...d, calendarType: t },
              ),
            );
          }
        }

        context.logger.info("Found {count} calendar deployments", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    configureGraphDeployment: {
      description:
        "Configure a Microsoft 365 Graph API calendar deployment for OTJ.",
      arguments: z.object({
        name: z.string().describe("Deployment name"),
        description: z.string().optional(),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          enabled: args.enabled,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/mjx_graph_deployment/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created O365 Graph calendar deployment {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    configureExchangeDeployment: {
      description:
        "Configure an Exchange on-premises calendar deployment for OTJ.",
      arguments: z.object({
        name: z.string().describe("Deployment name"),
        description: z.string().optional(),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          enabled: args.enabled,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/mjx_exchange_deployment/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created Exchange calendar deployment {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    configureGoogleDeployment: {
      description: "Configure a Google Workspace calendar deployment for OTJ.",
      arguments: z.object({
        name: z.string().describe("Deployment name"),
        description: z.string().optional(),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          enabled: args.enabled,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/mjx_google_deployment/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created Google calendar deployment {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    // --- OTJ status ---

    getEndpointStatus: {
      description: "Get status of OTJ endpoints (last poll, errors).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const statuses = await pexipListAll(`${STATUS_BASE}/mjx_endpoint/`, g);
        context.logger.info("Got status for {count} OTJ endpoints", {
          count: statuses.length,
        });
        return { dataHandles: [] };
      },
    },

    listMeetings: {
      description:
        "List active OTJ meetings (upcoming dial buttons pushed to endpoints).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const meetings = await pexipListAll(`${STATUS_BASE}/mjx_meeting/`, g);
        context.logger.info("Found {count} OTJ meetings", {
          count: meetings.length,
        });

        const handles = [];
        for (const m of meetings) {
          handles.push(
            await context.writeResource(
              "meeting",
              sanitizeId(`${m.endpoint_name}-${m.id}`),
              m,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    // --- Full OTJ inventory ---

    inventory: {
      description:
        "Full OTJ inventory — profiles, groups, endpoints, rules, calendar deployments.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const handles = [];

        const profiles = await pexipListAll(
          `${CONFIG_BASE}/mjx_integration/`,
          g,
        );
        for (const p of profiles) {
          handles.push(
            await context.writeResource(
              "profile",
              sanitizeId(p.name as string),
              p,
            ),
          );
        }

        const groups = await pexipListAll(
          `${CONFIG_BASE}/mjx_endpoint_group/`,
          g,
        );
        for (const grp of groups) {
          handles.push(
            await context.writeResource(
              "endpointGroup",
              sanitizeId(grp.name as string),
              grp,
            ),
          );
        }

        const endpoints = await pexipListAll(`${CONFIG_BASE}/mjx_endpoint/`, g);
        for (const ep of endpoints) {
          handles.push(
            await context.writeResource(
              "endpoint",
              sanitizeId(ep.name as string),
              ep,
            ),
          );
        }

        const rules = await pexipListAll(
          MEETING_RULE_PATH,
          g,
        );
        for (const r of rules) {
          handles.push(
            await context.writeResource(
              "meetingRule",
              sanitizeId(r.name as string),
              enrichMeetingRule(r),
            ),
          );
        }

        context.logger.info(
          "OTJ inventory: {profiles} profiles, {groups} groups, {endpoints} endpoints, {rules} rules",
          {
            profiles: profiles.length,
            groups: groups.length,
            endpoints: endpoints.length,
            rules: rules.length,
          },
        );

        return { dataHandles: handles };
      },
    },
  }),
};
