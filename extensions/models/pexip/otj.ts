import { z } from "npm:zod@4";
import {
  CONFIG_BASE,
  extractId,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
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
  })
  .passthrough();

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

export const model = {
  type: "@dougschaefer/pexip-otj",
  version: "2026.03.26.1",
  globalArguments: PexipGlobalArgsSchema,
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
  methods: {
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
        "List OTJ meeting processing rules (URI pattern matching for dial strings).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const rules = await pexipListAll(
          `${CONFIG_BASE}/mjx_meeting_processing_rule/`,
          g,
        );
        context.logger.info("Found {count} meeting processing rules", {
          count: rules.length,
        });
        const handles = [];
        for (const r of rules) {
          handles.push(
            await context.writeResource(
              "meetingRule",
              sanitizeId(r.name as string),
              r,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    createMeetingRule: {
      description: "Create an OTJ meeting processing rule.",
      arguments: z.object({
        name: z.string().describe("Rule name"),
        priority: z.number().optional().default(100),
        matchString: z.string().describe("Regex to match meeting URI"),
        replaceString: z.string().optional().describe(
          "Replacement for dial string",
        ),
        meetingType: z
          .enum([
            "pexip",
            "teams",
            "skype_for_business",
            "google_meet",
            "google_meet_sip_guest_join",
            "webex",
            "zoom",
            "gotomeeting",
            "other",
          ])
          .optional()
          .default("pexip"),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          priority: args.priority,
          match_string: args.matchString,
          meeting_type: args.meetingType,
          enable: args.enabled,
        };
        if (args.replaceString) body.replace_string = args.replaceString;

        await pexipApi(`${CONFIG_BASE}/mjx_meeting_processing_rule/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created meeting processing rule {name}", {
          name: args.name,
        });
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
          `${CONFIG_BASE}/mjx_meeting_processing_rule/`,
          g,
        );
        for (const r of rules) {
          handles.push(
            await context.writeResource(
              "meetingRule",
              sanitizeId(r.name as string),
              r,
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
  },
};
