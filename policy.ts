import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity external policy server management and development.
 *
 * External policy servers are HTTP(S) endpoints that Pexip conferencing nodes
 * query before processing calls. They handle six request types:
 *
 *   1. Service Configuration — what happens when a call arrives (route, reject,
 *      redirect, dynamically create VMR)
 *   2. Participant Properties — modify identity, role, display name, permissions
 *   3. Media Location — which node/location handles this participant's media
 *   4. Participant Avatar — custom image per participant
 *   5. Directory Information — phonebook/directory entries
 *   6. Registration Alias — allow/deny device registration
 *
 * Policy servers receive GET requests with call metadata as query parameters
 * and return JSON responses. The conferencing node has a 5-second timeout and
 * falls back to its internal database on failure.
 *
 * This model manages:
 *   - Policy server registration on the Pexip platform
 *   - Policy profiles that bind servers to system locations
 *   - Local policy scripts (Jinja2 templates for post-processing)
 *   - Policy response validation and testing
 *
 * Docs: https://docs.pexip.com/admin/external_policy.htm
 * Request/response ref: https://docs.pexip.com/admin/external_policy_requests.htm
 */

// --- Policy response schemas for validation ---

const ServiceConfigResponseSchema = z.object({
  status: z.enum(["success", "error"]),
  action: z.enum(["continue", "reject", "redirect"]).optional(),
  result: z
    .object({
      name: z.string().optional(),
      service_type: z
        .enum([
          "conference",
          "gateway",
          "lecture",
          "two_stage_dialing",
          "media_playback",
          "test_call",
        ])
        .optional(),
      pin: z.string().optional(),
      guest_pin: z.string().optional(),
      allow_guests: z.boolean().optional(),
      participant_limit: z.number().optional(),
      host_view: z.string().optional(),
      guests_can_present: z.boolean().optional(),
      ivr_theme_name: z.string().optional(),
      enable_chat: z.enum(["yes", "no", "default"]).optional(),
      enable_overlay_text: z.boolean().optional(),
      enable_active_speaker_indication: z.boolean().optional(),
      max_callrate_in: z.number().optional(),
      max_callrate_out: z.number().optional(),
      crypto_mode: z
        .enum(["besteffort", "on", "off"])
        .optional(),
      classification: z.string().optional(),
      automatic_participants: z
        .array(
          z.object({
            alias: z.string(),
            protocol: z
              .enum(["sip", "h323", "rtmp", "mssip", "auto"])
              .optional(),
            role: z.enum(["chair", "guest"]).optional(),
            dtmf_sequence: z.string().optional(),
            streaming: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .passthrough()
    .optional(),
  redirect_url: z.string().optional(),
}).passthrough();

const ParticipantPropertiesResponseSchema = z.object({
  status: z.enum(["success", "error"]),
  action: z.enum(["continue", "reject"]).optional(),
  result: z
    .object({
      remote_alias: z.string().optional(),
      remote_display_name: z.string().optional(),
      role: z.enum(["chair", "guest"]).optional(),
      has_media: z.boolean().optional(),
      bypass_conference_lock: z.boolean().optional(),
      guests_can_present: z.boolean().optional(),
      max_callrate_in: z.number().optional(),
      max_callrate_out: z.number().optional(),
      audio_mix: z.string().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();

/**
 * `@dougschaefer/pexip-policy` model — external policy and local
 * policy-profile control for Pexip Infinity on the v39 management
 * API. External policy lets Infinity defer service-config,
 * participant-properties, and avatar lookups to an HTTP callout
 * service, replacing local VMR configuration for the lookup
 * decisions. Server CRUD (listServers, getServer, createServer,
 * deleteServer) registers those callout endpoints with their URLs,
 * timeouts, and TLS material. Profile CRUD
 * (listProfiles/createProfile/updateProfile/deleteProfile) defines
 * local policy profiles for participant properties and routing.
 * testServiceConfig, testParticipantProperties, and validateResponse
 * exercise the registered callout against a synthetic request so the
 * external service can be validated before being put in the live
 * call path. inventory rolls the policy posture into one read.
 * Mutations on a server actively in use change how every relevant
 * call is authorized — stage and validate before rollout.
 */
export const model = {
  type: "@dougschaefer/pexip-policy",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Policy server management ---

    listServers: {
      description:
        "List all registered external policy servers on the platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(
          `${CONFIG_BASE}/policy_server/`,
          g,
        );

        context.logger.info("Found {count} policy servers", {
          count: servers.length,
        });

        return {
          data: {
            attributes: { servers, count: servers.length },
            name: "policy-servers",
          },
        };
      },
    },

    getServer: {
      description: "Get details of a specific policy server by name.",
      arguments: z.object({
        name: z.string().describe("Policy server name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(
          `${CONFIG_BASE}/policy_server/`,
          g,
          { name: args.name },
        );

        if (servers.length === 0) {
          throw new Error(`Policy server '${args.name}' not found`);
        }

        return {
          data: {
            attributes: servers[0],
            name: `server-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    createServer: {
      description:
        "Register an external policy server endpoint on the platform.",
      arguments: z.object({
        name: z.string().describe("Policy server name"),
        url: z
          .string()
          .url()
          .describe(
            "Policy server base URL (e.g., https://policy.example.com). Pexip appends /policy/v1/<request_type> to this.",
          ),
        username: z
          .string()
          .optional()
          .describe("HTTP basic auth username for the policy server"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("HTTP basic auth password"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          url: args.url,
        };
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/policy_server/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created policy server '{name}' → {url}", {
          name: args.name,
          url: args.url,
        });

        return {
          data: {
            attributes: { name: args.name, url: args.url },
            name: `server-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deleteServer: {
      description: "Remove an external policy server registration.",
      arguments: z.object({
        name: z.string().describe("Policy server name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(
          `${CONFIG_BASE}/policy_server/`,
          g,
          { name: args.name },
        );

        if (servers.length === 0) {
          throw new Error(`Policy server '${args.name}' not found`);
        }

        const uri = servers[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted policy server '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-server-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Policy profiles ---

    listProfiles: {
      description:
        "List all policy profiles. Profiles bind policy servers and local scripts to system locations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const profiles = await pexipListAll(
          `${CONFIG_BASE}/policy_profile/`,
          g,
        );

        context.logger.info("Found {count} policy profiles", {
          count: profiles.length,
        });

        return {
          data: {
            attributes: { profiles, count: profiles.length },
            name: "policy-profiles",
          },
        };
      },
    },

    createProfile: {
      description:
        "Create a policy profile that binds a policy server and/or local script to a system location.",
      arguments: z.object({
        name: z.string().describe("Profile name"),
        policyServer: z
          .string()
          .optional()
          .describe(
            "Name of the external policy server to use (must already exist)",
          ),
        localScript: z
          .string()
          .optional()
          .describe(
            "Jinja2 local policy script content (max 49,152 chars). Executes after external policy returns.",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };

        if (args.policyServer) {
          const servers = await pexipListAll(
            `${CONFIG_BASE}/policy_server/`,
            g,
            { name: args.policyServer },
          );
          if (servers.length === 0) {
            throw new Error(
              `Policy server '${args.policyServer}' not found`,
            );
          }
          body.policy_server = servers[0].resource_uri;
        }

        if (args.localScript) {
          body.local_policy_script = args.localScript;
        }

        await pexipApi(`${CONFIG_BASE}/policy_profile/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created policy profile '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: {
              name: args.name,
              policyServer: args.policyServer || null,
              hasLocalScript: !!args.localScript,
            },
            name: `profile-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    updateProfile: {
      description: "Update a policy profile's server binding or local script.",
      arguments: z.object({
        name: z.string().describe("Profile name to update"),
        policyServer: z
          .string()
          .optional()
          .describe("New policy server name (empty string to unbind)"),
        localScript: z
          .string()
          .optional()
          .describe("Updated Jinja2 local policy script content"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const profiles = await pexipListAll(
          `${CONFIG_BASE}/policy_profile/`,
          g,
          { name: args.name },
        );

        if (profiles.length === 0) {
          throw new Error(`Policy profile '${args.name}' not found`);
        }

        const uri = profiles[0].resource_uri as string;
        const body: Record<string, unknown> = {};

        if (args.policyServer !== undefined) {
          if (args.policyServer === "") {
            body.policy_server = null;
          } else {
            const servers = await pexipListAll(
              `${CONFIG_BASE}/policy_server/`,
              g,
              { name: args.policyServer },
            );
            if (servers.length === 0) {
              throw new Error(
                `Policy server '${args.policyServer}' not found`,
              );
            }
            body.policy_server = servers[0].resource_uri;
          }
        }

        if (args.localScript !== undefined) {
          body.local_policy_script = args.localScript;
        }

        await pexipApi(uri, g, { method: "PATCH", body });

        context.logger.info("Updated policy profile '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { name: args.name, updated: Object.keys(body) },
            name: `profile-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deleteProfile: {
      description: "Delete a policy profile.",
      arguments: z.object({
        name: z.string().describe("Profile name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const profiles = await pexipListAll(
          `${CONFIG_BASE}/policy_profile/`,
          g,
          { name: args.name },
        );

        if (profiles.length === 0) {
          throw new Error(`Policy profile '${args.name}' not found`);
        }

        const uri = profiles[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted policy profile '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-profile-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Policy testing and validation ---

    testServiceConfig: {
      description:
        "Simulate a service configuration policy request. Sends the same query parameters a conferencing node would send to your policy server and returns the response. Use this to validate policy server behavior without placing a real call.",
      arguments: z.object({
        policyServerUrl: z
          .string()
          .url()
          .describe("Base URL of the policy server to test against"),
        localAlias: z
          .string()
          .describe(
            "The alias being called (e.g., meet.12345, sip:room@example.com)",
          ),
        remoteAlias: z
          .string()
          .optional()
          .describe("The caller's alias/URI"),
        protocol: z
          .enum([
            "sip",
            "h323",
            "webrtc",
            "mssip",
            "teams",
            "ghm",
            "rtmp",
            "api",
          ])
          .default("sip")
          .describe("Call protocol"),
        callDirection: z
          .enum(["dial_in", "dial_out"])
          .default("dial_in")
          .describe("Call direction"),
        locationName: z
          .string()
          .optional()
          .describe("System location name to include in request"),
        vendor: z
          .string()
          .optional()
          .describe("Endpoint vendor string"),
        policyServerUsername: z
          .string()
          .optional()
          .describe(
            "HTTP basic auth username if the policy server requires it",
          ),
        policyServerPassword: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("HTTP basic auth password"),
      }),
      execute: async (args, context) => {
        const params = new URLSearchParams();
        params.set("local_alias", args.localAlias);
        if (args.remoteAlias) params.set("remote_alias", args.remoteAlias);
        params.set("protocol", args.protocol);
        params.set("call_direction", args.callDirection);
        if (args.locationName) params.set("location", args.locationName);
        if (args.vendor) params.set("vendor", args.vendor);

        const url =
          `${args.policyServerUrl}/policy/v1/service/configuration?${params.toString()}`;

        const headers: Record<string, string> = {
          Accept: "application/json",
        };
        if (args.policyServerUsername && args.policyServerPassword) {
          headers.Authorization = `Basic ${
            btoa(`${args.policyServerUsername}:${args.policyServerPassword}`)
          }`;
        }

        context.logger.info("Testing service config: {url}", { url });

        const resp = await fetch(url, { headers });
        const body = await resp.text();

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return {
            data: {
              attributes: {
                success: false,
                httpStatus: resp.status,
                error: "Response is not valid JSON",
                rawBody: body.slice(0, 2000),
              },
              name: `test-svc-${sanitizeId(args.localAlias)}`,
            },
          };
        }

        // Validate against the expected schema
        const validation = ServiceConfigResponseSchema.safeParse(parsed);

        context.logger.info(
          "Policy response: status={httpStatus}, action={action}, valid={valid}",
          {
            httpStatus: resp.status,
            action: (parsed as Record<string, unknown>)?.action ?? "none",
            valid: validation.success,
          },
        );

        return {
          data: {
            attributes: {
              success: resp.ok,
              httpStatus: resp.status,
              response: parsed,
              schemaValid: validation.success,
              schemaErrors: validation.success
                ? null
                : validation.error.issues.map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                })),
            },
            name: `test-svc-${sanitizeId(args.localAlias)}`,
          },
        };
      },
    },

    testParticipantProperties: {
      description:
        "Simulate a participant properties policy request against your policy server.",
      arguments: z.object({
        policyServerUrl: z
          .string()
          .url()
          .describe("Base URL of the policy server"),
        conferenceAlias: z
          .string()
          .describe("The conference alias the participant is joining"),
        participantAlias: z
          .string()
          .describe("The participant's alias/URI"),
        protocol: z
          .enum([
            "sip",
            "h323",
            "webrtc",
            "mssip",
            "teams",
            "ghm",
            "rtmp",
            "api",
          ])
          .default("sip"),
        role: z
          .enum(["chair", "guest", "unknown"])
          .default("unknown")
          .describe("Participant's current role"),
        policyServerUsername: z
          .string()
          .optional()
          .describe("HTTP basic auth username"),
        policyServerPassword: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("HTTP basic auth password"),
      }),
      execute: async (args, context) => {
        const params = new URLSearchParams();
        params.set("local_alias", args.conferenceAlias);
        params.set("remote_alias", args.participantAlias);
        params.set("protocol", args.protocol);
        params.set("role", args.role);

        const url =
          `${args.policyServerUrl}/policy/v1/participant/properties?${params.toString()}`;

        const headers: Record<string, string> = {
          Accept: "application/json",
        };
        if (args.policyServerUsername && args.policyServerPassword) {
          headers.Authorization = `Basic ${
            btoa(`${args.policyServerUsername}:${args.policyServerPassword}`)
          }`;
        }

        context.logger.info("Testing participant properties: {url}", { url });

        const resp = await fetch(url, { headers });
        const body = await resp.text();

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return {
            data: {
              attributes: {
                success: false,
                httpStatus: resp.status,
                error: "Response is not valid JSON",
                rawBody: body.slice(0, 2000),
              },
              name: `test-participant-${sanitizeId(args.participantAlias)}`,
            },
          };
        }

        const validation = ParticipantPropertiesResponseSchema.safeParse(
          parsed,
        );

        return {
          data: {
            attributes: {
              success: resp.ok,
              httpStatus: resp.status,
              response: parsed,
              schemaValid: validation.success,
              schemaErrors: validation.success
                ? null
                : validation.error.issues.map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                })),
            },
            name: `test-participant-${sanitizeId(args.participantAlias)}`,
          },
        };
      },
    },

    validateResponse: {
      description:
        "Validate a policy response JSON object against the Pexip policy response schema without making any network calls. Useful for testing policy server implementations offline.",
      arguments: z.object({
        requestType: z
          .enum(["service_configuration", "participant_properties"])
          .describe("Which policy request type this response is for"),
        response: z
          .string()
          .describe("JSON string of the policy response to validate"),
      }),
      execute: (args, context) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.response);
        } catch (e) {
          return {
            data: {
              attributes: {
                valid: false,
                error: `Invalid JSON: ${(e as Error).message}`,
              },
              name: `validation-${args.requestType}`,
            },
          };
        }

        const schema = args.requestType === "service_configuration"
          ? ServiceConfigResponseSchema
          : ParticipantPropertiesResponseSchema;

        const result = schema.safeParse(parsed);

        context.logger.info(
          "Validation {requestType}: {valid}",
          { requestType: args.requestType, valid: result.success },
        );

        return {
          data: {
            attributes: {
              valid: result.success,
              requestType: args.requestType,
              errors: result.success ? null : result.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
                received: i.received,
              })),
              parsedResponse: parsed,
            },
            name: `validation-${args.requestType}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full policy inventory: all policy servers, profiles, and their bindings in one call.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [servers, profiles] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/policy_server/`, g),
          pexipListAll(`${CONFIG_BASE}/policy_profile/`, g),
        ]);

        context.logger.info(
          "Policy inventory: {serverCount} servers, {profileCount} profiles",
          { serverCount: servers.length, profileCount: profiles.length },
        );

        return {
          data: {
            attributes: {
              servers,
              profiles,
              serverCount: servers.length,
              profileCount: profiles.length,
            },
            name: "policy-inventory",
          },
        };
      },
    },
  },
};
