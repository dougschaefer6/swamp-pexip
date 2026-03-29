import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  extractId,
  HISTORY_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
  STATUS_BASE,
} from "./_client.ts";

// --- Resource schemas ---

const VmrSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    aliases: z.array(z.record(z.string(), z.unknown())).optional(),
    host_pin: z.string().optional(),
    guest_pin: z.string().optional(),
    allow_guests: z.boolean().optional(),
    participant_limit: z.number().optional(),
    service_type: z.string().optional(),
    tag: z.string().optional(),
    theme: z.string().optional(),
    ivr_theme: z.string().optional(),
    max_callrate_in: z.number().optional(),
    max_callrate_out: z.number().optional(),
    enable_overlay_text: z.boolean().optional(),
    force_presenter_into_main: z.boolean().optional(),
    automatically_dialed_participants: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
  })
  .passthrough();

const CallRoutingRuleSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    priority: z.number().optional(),
    match_string: z.string().optional(),
    replace_string: z.string().optional(),
    protocol: z.string().optional(),
    called_device_type: z.string().optional(),
    enable: z.boolean().optional(),
    treat_as_trusted: z.boolean().optional(),
    media_encryption: z.string().optional(),
  })
  .passthrough();

const ActiveConferenceSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    service_type: z.string().optional(),
    start_time: z.string().optional(),
    duration: z.number().optional(),
    is_locked: z.boolean().optional(),
    is_started: z.boolean().optional(),
    participant_count: z.number().optional(),
    participants: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    tag: z.string().optional(),
  })
  .passthrough();

const ConferenceHistorySchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    service_type: z.string().optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    duration: z.number().optional(),
    tag: z.string().optional(),
    participants: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
  })
  .passthrough();

const GatewayRuleSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    priority: z.number().optional(),
    match_string: z.string().optional(),
    replace_string: z.string().optional(),
    outgoing_protocol: z.string().optional(),
    called_device_type: z.string().optional(),
    treat_as_trusted: z.boolean().optional(),
    enable: z.boolean().optional(),
  })
  .passthrough();

export const model = {
  type: "@dougschaefer/pexip-conference",
  version: "2026.03.26.1",
  globalArguments: PexipGlobalArgsSchema,
  resources: {
    vmr: {
      description: "Virtual Meeting Room configuration",
      schema: VmrSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    callRoutingRule: {
      description: "Call routing rule (inbound call matching)",
      schema: CallRoutingRuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    activeConference: {
      description: "Currently active conference with participants",
      schema: ActiveConferenceSchema,
      lifetime: "1h" as const,
      garbageCollection: 50,
    },
    conferenceHistory: {
      description: "Historical conference record",
      schema: ConferenceHistorySchema,
      lifetime: "7d" as const,
      garbageCollection: 100,
    },
    gatewayRule: {
      description: "Gateway routing rule (outbound/interop)",
      schema: GatewayRuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    // --- VMR management ---

    listVmrs: {
      description: "List all Virtual Meeting Rooms.",
      arguments: z.object({
        tag: z.string().optional().describe("Filter by tag"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.tag) params.tag = args.tag;

        const vmrs = await pexipListAll(
          `${CONFIG_BASE}/conference/`,
          g,
          params,
        );

        context.logger.info("Found {count} VMRs", { count: vmrs.length });

        const handles = [];
        for (const vmr of vmrs) {
          const handle = await context.writeResource(
            "vmr",
            sanitizeId(vmr.name as string),
            vmr,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createVmr: {
      description: "Create a new Virtual Meeting Room.",
      arguments: z.object({
        name: z.string().describe("VMR name / display name"),
        aliases: z
          .array(
            z.object({
              alias: z.string(),
              description: z.string().optional(),
            }),
          )
          .describe("SIP/H.323/WebRTC aliases for this VMR"),
        hostPin: z.string().optional().describe("Host PIN (digits)"),
        guestPin: z.string().optional().describe("Guest PIN (digits)"),
        allowGuests: z
          .boolean()
          .optional()
          .default(true)
          .describe("Allow guest access"),
        participantLimit: z
          .number()
          .optional()
          .describe("Max participants (0 = unlimited)"),
        serviceType: z
          .enum(["conference", "lecture", "two_stage_dialing", "test_call"])
          .optional()
          .default("conference"),
        tag: z.string().optional().describe("Tag for grouping/filtering"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          aliases: args.aliases,
          service_type: args.serviceType,
        };
        if (args.hostPin) body.host_pin = args.hostPin;
        if (args.guestPin) body.guest_pin = args.guestPin;
        if (args.allowGuests !== undefined) {
          body.allow_guests = args.allowGuests;
        }
        if (args.participantLimit !== undefined) {
          body.participant_limit = args.participantLimit;
        }
        if (args.tag) body.tag = args.tag;

        await pexipApi(`${CONFIG_BASE}/conference/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created VMR {name}", { name: args.name });

        // Fetch back
        const vmrs = await pexipListAll(`${CONFIG_BASE}/conference/`, g, {
          name: args.name,
        });
        const created = vmrs.find((v) => v.name === args.name);

        if (created) {
          const handle = await context.writeResource(
            "vmr",
            sanitizeId(args.name),
            created,
          );
          return { dataHandles: [handle] };
        }
        return { dataHandles: [] };
      },
    },

    deleteVmr: {
      description: "Delete a Virtual Meeting Room.",
      arguments: z.object({
        name: z.string().describe("VMR name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const vmrs = await pexipListAll(`${CONFIG_BASE}/conference/`, g, {
          name: args.name,
        });
        const vmr = vmrs.find((v) => v.name === args.name);
        if (!vmr) throw new Error(`VMR not found: ${args.name}`);

        const vmrId = extractId(vmr.resource_uri as string);
        await pexipApi(`${CONFIG_BASE}/conference/${vmrId}/`, g, {
          method: "DELETE",
        });

        context.logger.info("Deleted VMR {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- Call routing ---

    listCallRoutingRules: {
      description:
        "List all gateway routing rules (handles both incoming and outgoing call matching).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const rules = await pexipListAll(
          `${CONFIG_BASE}/gateway_routing_rule/`,
          g,
        );

        context.logger.info("Found {count} call routing rules", {
          count: rules.length,
        });

        const handles = [];
        for (const rule of rules) {
          const handle = await context.writeResource(
            "callRoutingRule",
            sanitizeId(rule.name as string),
            rule,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createCallRoutingRule: {
      description:
        "Create a gateway routing rule for call matching (incoming or outgoing).",
      arguments: z.object({
        name: z.string().describe("Rule name"),
        matchString: z
          .string()
          .describe("Regex pattern to match incoming alias"),
        replaceString: z
          .string()
          .optional()
          .describe("Replacement string for the alias"),
        priority: z
          .number()
          .optional()
          .default(100)
          .describe("Rule priority (lower = higher priority)"),
        protocol: z
          .enum(["sip", "h323", "webrtc", "mssip", "any"])
          .optional()
          .default("any"),
        calledDeviceType: z
          .enum(["external", "conference", "gateway", "test_call"])
          .optional()
          .default("external"),
        mediaEncryption: z
          .enum(["required", "optional", "none"])
          .optional()
          .describe("Media encryption requirement"),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          match_string: args.matchString,
          priority: args.priority,
          protocol: args.protocol,
          called_device_type: args.calledDeviceType,
          enable: args.enabled,
        };
        if (args.replaceString) body.replace_string = args.replaceString;
        if (args.mediaEncryption) {
          body.media_encryption = args.mediaEncryption;
        }

        await pexipApi(`${CONFIG_BASE}/gateway_routing_rule/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created call routing rule {name}", {
          name: args.name,
        });

        return { dataHandles: [] };
      },
    },

    // --- Gateway rules ---

    listGatewayRules: {
      description: "List all gateway routing rules (outbound/interop).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const rules = await pexipListAll(
          `${CONFIG_BASE}/gateway_routing_rule/`,
          g,
        );

        context.logger.info("Found {count} gateway rules", {
          count: rules.length,
        });

        const handles = [];
        for (const rule of rules) {
          const handle = await context.writeResource(
            "gatewayRule",
            sanitizeId(rule.name as string),
            rule,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- Active conferences ---

    listActiveConferences: {
      description:
        "List all currently active conferences and their participants.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const conferences = await pexipListAll(
          `${STATUS_BASE}/conference/`,
          g,
        );

        context.logger.info("Found {count} active conferences", {
          count: conferences.length,
        });

        const handles = [];
        for (const conf of conferences) {
          const handle = await context.writeResource(
            "activeConference",
            sanitizeId(conf.name as string || `conf-${conf.id}`),
            conf,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    disconnectParticipant: {
      description: "Disconnect a participant from an active conference.",
      arguments: z.object({
        conferenceId: z.string().describe("Conference ID"),
        participantId: z.string().describe("Participant ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          `${STATUS_BASE}/conference/${args.conferenceId}/participant/${args.participantId}/`,
          g,
          { method: "DELETE" },
        );

        context.logger.info(
          "Disconnected participant {pid} from conference {cid}",
          { pid: args.participantId, cid: args.conferenceId },
        );

        return { dataHandles: [] };
      },
    },

    lockConference: {
      description: "Lock or unlock an active conference.",
      arguments: z.object({
        conferenceId: z.string().describe("Conference ID"),
        locked: z.boolean().describe("true to lock, false to unlock"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const endpoint = args.locked
          ? "/api/admin/command/v1/conference/lock/"
          : "/api/admin/command/v1/conference/unlock/";

        await pexipApi(endpoint, g, {
          method: "POST",
          body: { conference_id: args.conferenceId },
        });

        context.logger.info("{action} conference {cid}", {
          action: args.locked ? "Locked" : "Unlocked",
          cid: args.conferenceId,
        });

        return { dataHandles: [] };
      },
    },

    muteParticipant: {
      description: "Mute or unmute a participant in an active conference.",
      arguments: z.object({
        participantId: z.string().describe("Participant ID"),
        muted: z.boolean().describe("true to mute, false to unmute"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const endpoint = args.muted
          ? "/api/admin/command/v1/participant/mute/"
          : "/api/admin/command/v1/participant/unmute/";

        await pexipApi(endpoint, g, {
          method: "POST",
          body: { participant_id: args.participantId },
        });

        context.logger.info("{action} participant {pid}", {
          action: args.muted ? "Muted" : "Unmuted",
          pid: args.participantId,
        });

        return { dataHandles: [] };
      },
    },

    muteAllGuests: {
      description: "Mute or unmute all guest participants in a conference.",
      arguments: z.object({
        conferenceId: z.string().describe("Conference ID"),
        muted: z.boolean().describe("true to mute all guests, false to unmute"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const endpoint = args.muted
          ? "/api/admin/command/v1/conference/mute_guests/"
          : "/api/admin/command/v1/conference/unmute_guests/";

        await pexipApi(endpoint, g, {
          method: "POST",
          body: { conference_id: args.conferenceId },
        });

        context.logger.info("{action} all guests in conference {cid}", {
          action: args.muted ? "Muted" : "Unmuted",
          cid: args.conferenceId,
        });

        return { dataHandles: [] };
      },
    },

    transferParticipant: {
      description: "Transfer a participant to a different conference.",
      arguments: z.object({
        participantId: z.string().describe("Participant ID to transfer"),
        destinationAlias: z
          .string()
          .describe("Conference alias to transfer to"),
        role: z
          .enum(["chair", "guest"])
          .optional()
          .default("guest")
          .describe("Role in the destination conference"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/participant/transfer/",
          g,
          {
            method: "POST",
            body: {
              participant_id: args.participantId,
              conference_alias: args.destinationAlias,
              role: args.role,
            },
          },
        );

        context.logger.info("Transferred participant {pid} to {dest}", {
          pid: args.participantId,
          dest: args.destinationAlias,
        });

        return { dataHandles: [] };
      },
    },

    changeParticipantRole: {
      description: "Change a participant's role (host/guest) in a conference.",
      arguments: z.object({
        participantId: z.string().describe("Participant ID"),
        role: z.enum(["chair", "guest"]).describe("New role"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/participant/role/",
          g,
          {
            method: "POST",
            body: {
              participant_id: args.participantId,
              role: args.role,
            },
          },
        );

        context.logger.info("Changed participant {pid} role to {role}", {
          pid: args.participantId,
          role: args.role,
        });

        return { dataHandles: [] };
      },
    },

    changeLayout: {
      description:
        "Change the video layout of an active conference. Layouts: 1:7, teams, ac, 1:21, 2:21, 2x2, 3x3, 4x4, 5x5, 1:0, 1:33.",
      arguments: z.object({
        conferenceId: z.string().describe("Conference ID"),
        layout: z
          .enum([
            "1:7",
            "teams",
            "ac",
            "1:21",
            "2:21",
            "2x2",
            "3x3",
            "4x4",
            "5x5",
            "1:0",
            "1:33",
          ])
          .describe("Layout identifier"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/conference/transform_layout/",
          g,
          {
            method: "POST",
            body: {
              conference_id: args.conferenceId,
              layout: args.layout,
            },
          },
        );

        context.logger.info("Changed layout to {layout} for conference {cid}", {
          layout: args.layout,
          cid: args.conferenceId,
        });

        return { dataHandles: [] };
      },
    },

    // --- Conference history ---

    getConferenceHistory: {
      description:
        "Get conference history records. Optionally filter by time range.",
      arguments: z.object({
        since: z
          .string()
          .optional()
          .describe("ISO timestamp — only conferences after this time"),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe("Max records to return"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {
          limit: String(args.limit),
        };
        if (args.since) params.start_time__gte = args.since;

        const history = await pexipListAll(
          `${HISTORY_BASE}/conference/`,
          g,
          params,
        );

        context.logger.info("Found {count} conference history records", {
          count: history.length,
        });

        const handles = [];
        for (const record of history) {
          const handle = await context.writeResource(
            "conferenceHistory",
            sanitizeId(`${record.name}-${record.id}`),
            record,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- Conference aliases (standalone CRUD) ---

    listAliases: {
      description: "List all conference aliases across all VMRs.",
      arguments: z.object({
        alias: z.string().optional().describe(
          "Filter by alias string (substring match)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.alias) params.alias__contains = args.alias;

        const aliases = await pexipListAll(
          `${CONFIG_BASE}/conference_alias/`,
          g,
          params,
        );
        context.logger.info("Found {count} conference aliases", {
          count: aliases.length,
        });
        return { dataHandles: [] };
      },
    },

    addAlias: {
      description: "Add an alias to an existing conference/VMR.",
      arguments: z.object({
        conferenceUri: z.string().describe(
          "Resource URI of the conference (from listVmrs)",
        ),
        alias: z.string().describe("SIP/H.323/WebRTC alias string"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/conference_alias/`, g, {
          method: "POST",
          body: {
            conference: args.conferenceUri,
            alias: args.alias,
            description: args.description || "",
          },
        });
        context.logger.info("Added alias {alias} to conference", {
          alias: args.alias,
        });
        return { dataHandles: [] };
      },
    },

    deleteAlias: {
      description: "Remove an alias from a conference/VMR.",
      arguments: z.object({
        aliasId: z.string().describe("Alias ID (from listAliases)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/conference_alias/${args.aliasId}/`, g, {
          method: "DELETE",
        });
        context.logger.info("Deleted alias {id}", { id: args.aliasId });
        return { dataHandles: [] };
      },
    },

    // --- Automatic participants ---

    listAutoParticipants: {
      description:
        "List all automatically dialed participants (RTMP streaming, recording, always-on rooms).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const participants = await pexipListAll(
          `${CONFIG_BASE}/automatic_participant/`,
          g,
        );
        context.logger.info("Found {count} auto-dial participants", {
          count: participants.length,
        });
        return { dataHandles: [] };
      },
    },

    createAutoParticipant: {
      description:
        "Add an automatically dialed participant to a conference (e.g., RTMP stream, recording, always-on endpoint).",
      arguments: z.object({
        conferenceUri: z.string().describe("Resource URI of the conference"),
        remoteAlias: z.string().describe(
          "Alias/URI to dial (e.g., rtmp://stream.example.com/live)",
        ),
        protocol: z.enum(["sip", "h323", "mssip", "rtmp"]).default("sip"),
        role: z.enum(["chair", "guest"]).optional().default("guest"),
        localAlias: z.string().optional().describe(
          "Caller ID alias to present",
        ),
        localDisplayName: z.string().optional(),
        dtmfSequence: z.string().optional().describe(
          "DTMF digits to send after connect",
        ),
        streaming: z.boolean().optional().default(false).describe(
          "Mark as a streaming participant",
        ),
        keepConferenceAlive: z
          .enum([
            "keep_conference_alive",
            "keep_conference_alive_if_multiple",
            "keep_conference_alive_never",
          ])
          .optional()
          .default("keep_conference_alive_never"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          conference: args.conferenceUri,
          remote_alias: args.remoteAlias,
          protocol: args.protocol,
          role: args.role,
          keep_conference_alive: args.keepConferenceAlive,
        };
        if (args.localAlias) body.local_alias = args.localAlias;
        if (args.localDisplayName) {
          body.local_display_name = args.localDisplayName;
        }
        if (args.dtmfSequence) body.dtmf_sequence = args.dtmfSequence;
        if (args.streaming) body.streaming = args.streaming;

        await pexipApi(`${CONFIG_BASE}/automatic_participant/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created auto-participant {alias} ({protocol})", {
          alias: args.remoteAlias,
          protocol: args.protocol,
        });
        return { dataHandles: [] };
      },
    },

    deleteAutoParticipant: {
      description: "Remove an automatically dialed participant.",
      arguments: z.object({
        participantId: z.string().describe("Auto-participant ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          `${CONFIG_BASE}/automatic_participant/${args.participantId}/`,
          g,
          { method: "DELETE" },
        );
        context.logger.info("Deleted auto-participant {id}", {
          id: args.participantId,
        });
        return { dataHandles: [] };
      },
    },

    // --- Participant history (CDR-level) ---

    getParticipantHistory: {
      description:
        "Get participant-level call detail records (codec, quality, disconnect reason).",
      arguments: z.object({
        since: z.string().optional().describe(
          "ISO timestamp — only records after this time",
        ),
        conferenceId: z.string().optional().describe("Filter by conference ID"),
        limit: z.number().optional().default(50),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = { limit: String(args.limit) };
        if (args.since) params.start_time__gte = args.since;
        if (args.conferenceId) params.conference = args.conferenceId;

        const history = await pexipListAll(
          `${HISTORY_BASE}/participant/`,
          g,
          params,
        );
        context.logger.info("Found {count} participant history records", {
          count: history.length,
        });
        return { dataHandles: [] };
      },
    },

    getParticipantMediaHistory: {
      description:
        "Get media stream history for a historical participant (bitrate, codec, packet loss, jitter).",
      arguments: z.object({
        participantId: z.string().describe("Participant history record ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const streams = await pexipListAll(
          `${HISTORY_BASE}/participant/${args.participantId}/media_stream/`,
          g,
        );
        context.logger.info("Got {count} media streams for participant {pid}", {
          count: streams.length,
          pid: args.participantId,
        });
        return { dataHandles: [] };
      },
    },

    // --- Scheduled and recurring conferences ---

    listScheduledConferences: {
      description: "List scheduled (time-bounded) conferences.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const confs = await pexipListAll(
          `${CONFIG_BASE}/scheduled_conference/`,
          g,
        );
        context.logger.info("Found {count} scheduled conferences", {
          count: confs.length,
        });
        return { dataHandles: [] };
      },
    },

    listRecurringConferences: {
      description: "List recurring conference definitions.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const confs = await pexipListAll(
          `${CONFIG_BASE}/recurring_conference/`,
          g,
        );
        context.logger.info("Found {count} recurring conferences", {
          count: confs.length,
        });
        return { dataHandles: [] };
      },
    },
  },
};
