import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity event sink management for real-time automation.
 *
 * Event sinks deliver conference and participant lifecycle events from
 * conferencing nodes to external HTTP(S) endpoints via POST of JSON data.
 * They are the primary mechanism for building real-time integrations:
 * dashboards, incident management, billing, compliance recording, or any
 * event-driven automation.
 *
 * Supported events:
 *   - conference_started / conference_updated / conference_ended
 *   - participant_connected / participant_updated / participant_disconnected
 *   - participant_media_streams_destroyed (v2 API)
 *   - participant_media_stream_window (perceived quality changes, v2 API)
 *   - eventsink_started / eventsink_updated / eventsink_stopped
 *
 * Delivery modes:
 *   - One-by-one: ordered, sequential POST per event
 *   - Bulk: batched at configurable intervals under eventsink_bulk wrapper
 *
 * Event sinks are configured per system location. The same endpoint can
 * receive events from multiple locations.
 *
 * Docs: https://docs.pexip.com/admin/api_event_sink.htm
 */

// Schema for validating event sink payloads (for testing)
const ConferenceEventSchema = z.object({
  event: z.enum([
    "conference_started",
    "conference_updated",
    "conference_ended",
  ]),
  data: z.object({
    uuid: z.string(),
    name: z.string(),
    tag: z.string().optional(),
    is_locked: z.boolean().optional(),
    guests_muted: z.boolean().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
  }).passthrough(),
}).passthrough();

const ParticipantEventSchema = z.object({
  event: z.enum([
    "participant_connected",
    "participant_updated",
    "participant_disconnected",
    "participant_media_streams_destroyed",
  ]),
  data: z.object({
    uuid: z.string(),
    conference: z.string(),
    display_name: z.string().optional(),
    role: z.enum(["chair", "guest", "unknown"]).optional(),
    protocol: z.string().optional(),
    is_muted: z.boolean().optional(),
    is_presenting: z.boolean().optional(),
    has_media: z.boolean().optional(),
    call_direction: z.string().optional(),
    vendor: z.string().optional(),
    disconnect_reason: z.string().optional(),
    duration: z.number().optional(),
  }).passthrough(),
}).passthrough();

export const model = {
  type: "@dougschaefer/pexip-eventsink",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Event sink management ---

    list: {
      description:
        "List all configured event sinks with their target URLs, API versions, and delivery modes.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const sinks = await pexipListAll(
          `${CONFIG_BASE}/event_sink/`,
          g,
        );

        context.logger.info("Found {count} event sinks", {
          count: sinks.length,
        });

        return {
          data: {
            attributes: { sinks, count: sinks.length },
            name: "event-sinks",
          },
        };
      },
    },

    get: {
      description: "Get details of a specific event sink by name.",
      arguments: z.object({
        name: z.string().describe("Event sink name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const sinks = await pexipListAll(
          `${CONFIG_BASE}/event_sink/`,
          g,
          { name: args.name },
        );

        if (sinks.length === 0) {
          throw new Error(`Event sink '${args.name}' not found`);
        }

        return {
          data: {
            attributes: sinks[0],
            name: `sink-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    create: {
      description:
        "Create an event sink that POSTs conference and participant events to an HTTP(S) endpoint.",
      arguments: z.object({
        name: z.string().describe("Event sink name"),
        url: z
          .string()
          .url()
          .describe("Target URL to receive event POSTs"),
        username: z
          .string()
          .optional()
          .describe("HTTP basic auth username for the target"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("HTTP basic auth password"),
        verifyCert: z
          .boolean()
          .default(true)
          .describe("Verify TLS certificate of the target"),
        apiVersion: z
          .enum(["1", "2"])
          .default("2")
          .describe(
            "Event API version. v2 adds media_streams_destroyed and quality window events.",
          ),
        bulkMode: z
          .boolean()
          .default(false)
          .describe(
            "Enable bulk delivery mode (batched events at intervals instead of one-by-one)",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          url: args.url,
          verify_certificate: args.verifyCert,
          api_version: args.apiVersion,
          bulk_mode: args.bulkMode,
        };
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/event_sink/`, g, {
          method: "POST",
          body,
        });

        context.logger.info(
          "Created event sink '{name}' → {url} (v{version}, bulk={bulk})",
          {
            name: args.name,
            url: args.url,
            version: args.apiVersion,
            bulk: args.bulkMode,
          },
        );

        return {
          data: {
            attributes: {
              name: args.name,
              url: args.url,
              apiVersion: args.apiVersion,
              bulkMode: args.bulkMode,
            },
            name: `sink-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    update: {
      description: "Update an existing event sink configuration.",
      arguments: z.object({
        name: z.string().describe("Event sink name to update"),
        url: z.string().url().optional().describe("New target URL"),
        username: z.string().optional().describe("New auth username"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("New auth password"),
        verifyCert: z.boolean().optional().describe("New TLS verify setting"),
        apiVersion: z.enum(["1", "2"]).optional().describe("New API version"),
        bulkMode: z.boolean().optional().describe("New bulk mode setting"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const sinks = await pexipListAll(
          `${CONFIG_BASE}/event_sink/`,
          g,
          { name: args.name },
        );

        if (sinks.length === 0) {
          throw new Error(`Event sink '${args.name}' not found`);
        }

        const uri = sinks[0].resource_uri as string;
        const body: Record<string, unknown> = {};
        if (args.url !== undefined) body.url = args.url;
        if (args.username !== undefined) body.username = args.username;
        if (args.password !== undefined) body.password = args.password;
        if (args.verifyCert !== undefined) {
          body.verify_certificate = args.verifyCert;
        }
        if (args.apiVersion !== undefined) body.api_version = args.apiVersion;
        if (args.bulkMode !== undefined) body.bulk_mode = args.bulkMode;

        await pexipApi(uri, g, { method: "PATCH", body });

        context.logger.info("Updated event sink '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { name: args.name, updated: Object.keys(body) },
            name: `sink-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    delete: {
      description: "Delete an event sink.",
      arguments: z.object({
        name: z.string().describe("Event sink name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const sinks = await pexipListAll(
          `${CONFIG_BASE}/event_sink/`,
          g,
          { name: args.name },
        );

        if (sinks.length === 0) {
          throw new Error(`Event sink '${args.name}' not found`);
        }

        const uri = sinks[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted event sink '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-sink-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Event validation ---

    validateEvent: {
      description:
        "Validate an event sink payload against the Pexip event schema. Use this to test event sink receiver implementations offline.",
      arguments: z.object({
        eventJson: z
          .string()
          .describe("JSON string of the event payload to validate"),
      }),
      execute: (args, context) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.eventJson);
        } catch (e) {
          return {
            data: {
              attributes: {
                valid: false,
                error: `Invalid JSON: ${(e as Error).message}`,
              },
              name: "event-validation",
            },
          };
        }

        const eventType = (parsed as Record<string, unknown>)?.event as string;

        // Try conference event first, then participant
        const confResult = ConferenceEventSchema.safeParse(parsed);
        const partResult = ParticipantEventSchema.safeParse(parsed);

        const valid = confResult.success || partResult.success;
        const matchedType = confResult.success
          ? "conference"
          : partResult.success
          ? "participant"
          : "unknown";

        const errors = valid
          ? null
          : (partResult.error?.issues || confResult.error?.issues || []).map(
            (i) => ({
              path: i.path.join("."),
              message: i.message,
            }),
          );

        context.logger.info(
          "Event validation: type={eventType}, category={matchedType}, valid={valid}",
          { eventType: eventType || "unknown", matchedType, valid },
        );

        return {
          data: {
            attributes: {
              valid,
              eventType,
              category: matchedType,
              errors,
              parsedEvent: parsed,
            },
            name: "event-validation",
          },
        };
      },
    },

    // --- Test event delivery ---

    testDelivery: {
      description:
        "Send a test event payload to a URL to verify your event sink receiver is working. Sends a synthetic conference_started event.",
      arguments: z.object({
        url: z
          .string()
          .url()
          .describe("Event sink receiver URL to test"),
        username: z
          .string()
          .optional()
          .describe("HTTP basic auth username"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("HTTP basic auth password"),
        eventType: z
          .enum([
            "conference_started",
            "conference_ended",
            "participant_connected",
            "participant_disconnected",
          ])
          .default("conference_started")
          .describe("Event type to simulate"),
      }),
      execute: async (args, context) => {
        const now = new Date().toISOString();
        const testUuid = crypto.randomUUID();

        const events: Record<string, unknown> = {
          conference_started: {
            event: "conference_started",
            data: {
              uuid: testUuid,
              name: "swamp-test-conference",
              tag: "swamp-eventsink-test",
              is_locked: false,
              guests_muted: false,
              start_time: now,
            },
          },
          conference_ended: {
            event: "conference_ended",
            data: {
              uuid: testUuid,
              name: "swamp-test-conference",
              tag: "swamp-eventsink-test",
              end_time: now,
            },
          },
          participant_connected: {
            event: "participant_connected",
            data: {
              uuid: crypto.randomUUID(),
              conference: testUuid,
              display_name: "Swamp Test Participant",
              role: "chair",
              protocol: "api",
              is_muted: false,
              has_media: false,
              call_direction: "dial_in",
              vendor: "swamp-eventsink-test",
            },
          },
          participant_disconnected: {
            event: "participant_disconnected",
            data: {
              uuid: crypto.randomUUID(),
              conference: testUuid,
              display_name: "Swamp Test Participant",
              disconnect_reason: "Test complete",
              duration: 0,
            },
          },
        };

        const payload = events[args.eventType];

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (args.username && args.password) {
          headers.Authorization = `Basic ${
            btoa(`${args.username}:${args.password}`)
          }`;
        }

        context.logger.info(
          "Sending test {eventType} to {url}",
          { eventType: args.eventType, url: args.url },
        );

        const resp = await fetch(args.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        const responseBody = await resp.text();

        context.logger.info(
          "Test delivery: HTTP {status}",
          { status: resp.status },
        );

        return {
          data: {
            attributes: {
              success: resp.ok,
              httpStatus: resp.status,
              eventType: args.eventType,
              sentPayload: payload,
              responseBody: responseBody.slice(0, 2000),
            },
            name: `test-delivery-${args.eventType}`,
          },
        };
      },
    },
  },
};
