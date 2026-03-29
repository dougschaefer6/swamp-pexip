import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity Exchange/O365 calendar connector management and
 * scheduled scaling.
 *
 * Exchange connectors enable One-Touch-Join by reading room mailbox
 * calendars and pushing dial buttons to video endpoints. They support
 * Exchange on-premises, O365 via Graph API, and hybrid deployments.
 *
 * This is one of the most complex Pexip resources (~70 configurable fields
 * per the Terraform provider schema) covering:
 *   - Mailbox configuration (room mailbox, service account)
 *   - Authentication (basic, OAuth2, Kerberos)
 *   - Scheduled alias generation (dynamic VMR creation from calendar events)
 *   - Personal VMR provisioning for individual users
 *   - Add-in deployment (Outlook add-in for scheduling Pexip meetings)
 *   - Host identity provider integration
 *
 * Scheduled scaling manages cloud bursting policies that automatically
 * provision additional conferencing nodes during predicted high-usage
 * periods based on calendar analysis.
 *
 * Terraform ref: terraform-provider-pexip ms_exchange_connector resource
 * Docs: https://docs.pexip.com/admin/integrate_outlook.htm
 */

export const model = {
  type: "@dougschaefer/pexip-exchange",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Exchange connectors ---

    listConnectors: {
      description:
        "List all Exchange/O365 calendar connectors with their configuration state.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const connectors = await pexipListAll(
          `${CONFIG_BASE}/ms_exchange_connector/`,
          g,
        );

        context.logger.info("Found {count} Exchange connectors", {
          count: connectors.length,
        });

        return {
          data: {
            attributes: { connectors, count: connectors.length },
            name: "exchange-connectors",
          },
        };
      },
    },

    getConnector: {
      description:
        "Get full configuration details for a specific Exchange connector.",
      arguments: z.object({
        name: z.string().describe("Connector name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const connectors = await pexipListAll(
          `${CONFIG_BASE}/ms_exchange_connector/`,
          g,
          { name: args.name },
        );

        if (connectors.length === 0) {
          throw new Error(`Exchange connector '${args.name}' not found`);
        }

        return {
          data: {
            attributes: connectors[0],
            name: `connector-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    createConnector: {
      description:
        "Create an Exchange/O365 calendar connector for One-Touch-Join integration.",
      arguments: z.object({
        name: z.string().describe("Connector name"),
        roomMailboxEmail: z
          .string()
          .describe("Room mailbox email address to monitor"),
        roomMailboxName: z
          .string()
          .optional()
          .describe("Display name for the room mailbox"),
        url: z
          .string()
          .url()
          .describe("Exchange Web Services URL or Graph API endpoint"),
        authenticationMethod: z
          .enum(["basic", "oauth2", "kerberos"])
          .default("oauth2")
          .describe("Authentication method"),
        username: z
          .string()
          .optional()
          .describe("Service account username (for basic auth)"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("Service account password"),
        oauthClientId: z
          .string()
          .optional()
          .describe("OAuth2 client ID (for Graph API)"),
        oauthClientSecret: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("OAuth2 client secret"),
        oauthAuthEndpoint: z
          .string()
          .optional()
          .describe(
            "OAuth2 authorization endpoint (e.g., https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize)",
          ),
        oauthTokenEndpoint: z
          .string()
          .optional()
          .describe("OAuth2 token endpoint"),
        scheduledAliasDomain: z
          .string()
          .optional()
          .describe("Domain for generated scheduled aliases"),
        enableDynamicVmrs: z
          .boolean()
          .default(true)
          .describe("Automatically create VMRs from calendar events"),
        enablePersonalVmrs: z
          .boolean()
          .default(false)
          .describe("Enable personal VMR provisioning for users"),
        meetingBufferBefore: z
          .number()
          .default(5)
          .describe("Minutes before meeting to activate VMR"),
        meetingBufferAfter: z
          .number()
          .default(5)
          .describe("Minutes after meeting to deactivate VMR"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          room_mailbox_email_address: args.roomMailboxEmail,
          url: args.url,
          authentication_method: args.authenticationMethod,
          enable_dynamic_vmrs: args.enableDynamicVmrs,
          enable_personal_vmrs: args.enablePersonalVmrs,
          meeting_buffer_before: args.meetingBufferBefore,
          meeting_buffer_after: args.meetingBufferAfter,
        };

        if (args.roomMailboxName) {
          body.room_mailbox_name = args.roomMailboxName;
        }
        if (args.description) body.description = args.description;
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;
        if (args.oauthClientId) body.oauth_client_id = args.oauthClientId;
        if (args.oauthClientSecret) {
          body.oauth_client_secret = args.oauthClientSecret;
        }
        if (args.oauthAuthEndpoint) {
          body.oauth_auth_endpoint = args.oauthAuthEndpoint;
        }
        if (args.oauthTokenEndpoint) {
          body.oauth_token_endpoint = args.oauthTokenEndpoint;
        }
        if (args.scheduledAliasDomain) {
          body.scheduled_alias_domain = args.scheduledAliasDomain;
        }

        await pexipApi(`${CONFIG_BASE}/ms_exchange_connector/`, g, {
          method: "POST",
          body,
        });

        context.logger.info(
          "Created Exchange connector '{name}' for {email}",
          { name: args.name, email: args.roomMailboxEmail },
        );

        return {
          data: {
            attributes: {
              name: args.name,
              roomMailboxEmail: args.roomMailboxEmail,
              authenticationMethod: args.authenticationMethod,
            },
            name: `connector-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    updateConnector: {
      description: "Update an Exchange connector's configuration.",
      arguments: z.object({
        name: z.string().describe("Connector name to update"),
        roomMailboxEmail: z.string().optional(),
        url: z.string().url().optional(),
        enableDynamicVmrs: z.boolean().optional(),
        enablePersonalVmrs: z.boolean().optional(),
        meetingBufferBefore: z.number().optional(),
        meetingBufferAfter: z.number().optional(),
        oauthClientId: z.string().optional(),
        oauthClientSecret: z.string().optional().meta({ sensitive: true }),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const connectors = await pexipListAll(
          `${CONFIG_BASE}/ms_exchange_connector/`,
          g,
          { name: args.name },
        );

        if (connectors.length === 0) {
          throw new Error(`Exchange connector '${args.name}' not found`);
        }

        const uri = connectors[0].resource_uri as string;
        const body: Record<string, unknown> = {};
        if (args.roomMailboxEmail !== undefined) {
          body.room_mailbox_email_address = args.roomMailboxEmail;
        }
        if (args.url !== undefined) body.url = args.url;
        if (args.enableDynamicVmrs !== undefined) {
          body.enable_dynamic_vmrs = args.enableDynamicVmrs;
        }
        if (args.enablePersonalVmrs !== undefined) {
          body.enable_personal_vmrs = args.enablePersonalVmrs;
        }
        if (args.meetingBufferBefore !== undefined) {
          body.meeting_buffer_before = args.meetingBufferBefore;
        }
        if (args.meetingBufferAfter !== undefined) {
          body.meeting_buffer_after = args.meetingBufferAfter;
        }
        if (args.oauthClientId !== undefined) {
          body.oauth_client_id = args.oauthClientId;
        }
        if (args.oauthClientSecret !== undefined) {
          body.oauth_client_secret = args.oauthClientSecret;
        }

        await pexipApi(uri, g, { method: "PATCH", body });

        context.logger.info("Updated Exchange connector '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { name: args.name, updated: Object.keys(body) },
            name: `connector-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deleteConnector: {
      description: "Delete an Exchange connector.",
      arguments: z.object({
        name: z.string().describe("Connector name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const connectors = await pexipListAll(
          `${CONFIG_BASE}/ms_exchange_connector/`,
          g,
          { name: args.name },
        );

        if (connectors.length === 0) {
          throw new Error(`Exchange connector '${args.name}' not found`);
        }

        const uri = connectors[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted Exchange connector '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-connector-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Scheduled aliases ---

    listScheduledAliases: {
      description:
        "List all scheduled aliases (dynamically generated VMR aliases from calendar events).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const aliases = await pexipListAll(
          `${CONFIG_BASE}/scheduled_alias/`,
          g,
        );

        context.logger.info("Found {count} scheduled aliases", {
          count: aliases.length,
        });

        return {
          data: {
            attributes: { aliases, count: aliases.length },
            name: "scheduled-aliases",
          },
        };
      },
    },

    // --- Scheduled scaling ---

    listScalingPolicies: {
      description:
        "List all scheduled scaling policies for cloud bursting (automatically provisioning extra nodes during peak periods).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const policies = await pexipListAll(
          `${CONFIG_BASE}/scheduled_scaling/`,
          g,
        );

        context.logger.info("Found {count} scaling policies", {
          count: policies.length,
        });

        return {
          data: {
            attributes: { policies, count: policies.length },
            name: "scaling-policies",
          },
        };
      },
    },

    createScalingPolicy: {
      description:
        "Create a scheduled scaling policy for cloud bursting during predicted peak periods.",
      arguments: z.object({
        policyName: z.string().describe("Policy name"),
        policyType: z
          .enum(["azure", "aws", "gcp"])
          .describe("Cloud provider"),
        resourceIdentifier: z
          .string()
          .describe("Cloud resource identifier (VM scale set, ASG, etc.)"),
        enabled: z.boolean().default(true),
        instancesToAdd: z
          .number()
          .describe("Number of extra instances to provision"),
        minutesInAdvance: z
          .number()
          .default(30)
          .describe("Minutes before the event to start provisioning"),
        timeFrom: z
          .string()
          .describe("Daily start time (HH:MM)"),
        timeTo: z.string().describe("Daily end time (HH:MM)"),
        localTimezone: z
          .string()
          .default("UTC")
          .describe("Timezone for the schedule"),
        monday: z.boolean().default(true),
        tuesday: z.boolean().default(true),
        wednesday: z.boolean().default(true),
        thursday: z.boolean().default(true),
        friday: z.boolean().default(true),
        saturday: z.boolean().default(false),
        sunday: z.boolean().default(false),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        await pexipApi(`${CONFIG_BASE}/scheduled_scaling/`, g, {
          method: "POST",
          body: {
            policy_name: args.policyName,
            policy_type: args.policyType,
            resource_identifier: args.resourceIdentifier,
            enabled: args.enabled,
            instances_to_add: args.instancesToAdd,
            minutes_in_advance: args.minutesInAdvance,
            time_from: args.timeFrom,
            time_to: args.timeTo,
            local_timezone: args.localTimezone,
            mon: args.monday,
            tue: args.tuesday,
            wed: args.wednesday,
            thu: args.thursday,
            fri: args.friday,
            sat: args.saturday,
            sun: args.sunday,
          },
        });

        context.logger.info(
          "Created scaling policy '{name}': +{instances} instances {from}-{to}",
          {
            name: args.policyName,
            instances: args.instancesToAdd,
            from: args.timeFrom,
            to: args.timeTo,
          },
        );

        return {
          data: {
            attributes: {
              policyName: args.policyName,
              policyType: args.policyType,
              instancesToAdd: args.instancesToAdd,
            },
            name: `scaling-${sanitizeId(args.policyName)}`,
          },
        };
      },
    },

    deleteScalingPolicy: {
      description: "Delete a scheduled scaling policy.",
      arguments: z.object({
        policyName: z.string().describe("Policy name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const policies = await pexipListAll(
          `${CONFIG_BASE}/scheduled_scaling/`,
          g,
          { policy_name: args.policyName },
        );

        if (policies.length === 0) {
          throw new Error(
            `Scaling policy '${args.policyName}' not found`,
          );
        }

        const uri = policies[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted scaling policy '{name}'", {
          name: args.policyName,
        });

        return {
          data: {
            attributes: { deleted: args.policyName },
            name: `deleted-scaling-${sanitizeId(args.policyName)}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full Exchange/scheduling inventory: connectors, scheduled aliases, and scaling policies.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [connectors, aliases, scaling] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/ms_exchange_connector/`, g),
          pexipListAll(`${CONFIG_BASE}/scheduled_alias/`, g),
          pexipListAll(`${CONFIG_BASE}/scheduled_scaling/`, g),
        ]);

        context.logger.info(
          "Exchange inventory: {connectors} connectors, {aliases} aliases, {scaling} scaling policies",
          {
            connectors: connectors.length,
            aliases: aliases.length,
            scaling: scaling.length,
          },
        );

        return {
          data: {
            attributes: {
              connectors,
              scheduledAliases: aliases,
              scalingPolicies: scaling,
            },
            name: "exchange-inventory",
          },
        };
      },
    },
  },
};
