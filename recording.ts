import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity recording and streaming infrastructure.
 *
 * Pexip supports RTMP/RTMPS streaming from conferences to external recording
 * and streaming platforms. The recording architecture works as follows:
 *
 *   1. An RTMP endpoint is dialed into a conference as a participant
 *      (either automatically via auto-participants or manually via the dial API)
 *   2. The conferencing node sends the composite video + audio stream to the
 *      RTMP URI
 *   3. The receiving server (Wowza, pexrtmpserver, YouTube, etc.) records or
 *      relays the stream
 *
 * This model manages:
 *   - Auto-participant configurations for automatic recording on VMR activation
 *   - Manual RTMP dial-out for ad-hoc recording
 *   - Streaming credential management (for Pexip's own streaming service)
 *   - Media library entries (recorded content stored on the management node)
 *
 * Supported streaming targets:
 *   - Enterprise CDNs (Wowza, Quickchannel, Qumu, VideoTool, Microsoft Stream)
 *   - Public services (YouTube, Facebook)
 *   - Custom RTMP/RTMPS servers (including Pexip's own pexrtmpserver)
 *
 * Plugin: https://github.com/pexip/plugin-recording-rtmp
 * RTMP server: https://github.com/pexip/pexrtmpserver
 * Docs: https://docs.pexip.com/admin/streaming.htm
 */

/**
 * `@dougschaefer/pexip-recording` model — recording and streaming
 * surface for Pexip Infinity over the v39 management API. Auto-
 * recording CRUD (listAutoRecording, createAutoRecording,
 * deleteAutoRecording) configures the automatic-participant entries
 * that join a VMR on start and record or stream the call out (RTMP,
 * MS Stream, custom Pexip RTMP server). listStreamingCredentials
 * returns the per-target credentials stored on the platform for
 * destinations that require auth. listRecordings and deleteRecording
 * manage the archived recording inventory exposed through the
 * management API. inventory aggregates the recording posture for
 * audit. Mutations alter live recording policy on production VMRs —
 * verify compliance and data-handling requirements before changing
 * which conferences are recorded or where output is shipped.
 */
export const model = {
  type: "@dougschaefer/pexip-recording",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Auto-recording via auto-participants ---

    listAutoRecording: {
      description:
        "List all auto-participants configured for RTMP recording/streaming. These automatically dial an RTMP endpoint when the VMR activates.",
      arguments: z.object({
        vmrName: z
          .string()
          .optional()
          .describe("Filter by VMR name (list across all VMRs if omitted)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};

        if (args.vmrName) {
          // Find the VMR to get its resource URI
          const vmrs = await pexipListAll(
            `${CONFIG_BASE}/conference/`,
            g,
            { name: args.vmrName },
          );
          if (vmrs.length === 0) {
            throw new Error(`VMR '${args.vmrName}' not found`);
          }
          params.conference = vmrs[0].resource_uri as string;
        }

        const autoParticipants = await pexipListAll(
          `${CONFIG_BASE}/automatic_participant/`,
          g,
          params,
        );

        // Filter to RTMP/streaming entries
        const recordings = autoParticipants.filter(
          (p) =>
            p.protocol === "rtmp" ||
            p.streaming === true ||
            (p.alias as string)?.startsWith("rtmp"),
        );

        context.logger.info(
          "Found {count} auto-recording participants ({total} total auto-participants)",
          { count: recordings.length, total: autoParticipants.length },
        );

        return {
          data: {
            attributes: {
              recordings,
              count: recordings.length,
              vmrFilter: args.vmrName || "all",
            },
            name: args.vmrName
              ? `auto-recording-${sanitizeId(args.vmrName)}`
              : "auto-recording-all",
          },
        };
      },
    },

    createAutoRecording: {
      description:
        "Configure automatic RTMP recording on a VMR. When the VMR activates, Pexip dials the RTMP URI as a participant.",
      arguments: z.object({
        vmrName: z.string().describe("VMR name to attach recording to"),
        rtmpUri: z
          .string()
          .describe(
            "RTMP/RTMPS URI for the recording endpoint (e.g., rtmp://recorder.example.com/live/room1)",
          ),
        role: z
          .enum(["chair", "guest"])
          .default("guest")
          .describe("Role for the recording participant"),
        presentationUri: z
          .string()
          .optional()
          .describe(
            "Separate RTMP URI for capturing the presentation stream independently",
          ),
        dtmfSequence: z
          .string()
          .optional()
          .describe("DTMF digits to send after connecting (for PIN entry)"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        // Find the VMR
        const vmrs = await pexipListAll(`${CONFIG_BASE}/conference/`, g, {
          name: args.vmrName,
        });
        if (vmrs.length === 0) {
          throw new Error(`VMR '${args.vmrName}' not found`);
        }

        const body: Record<string, unknown> = {
          conference: vmrs[0].resource_uri,
          alias: args.rtmpUri,
          protocol: "rtmp",
          role: args.role,
          streaming: true,
        };
        if (args.presentationUri) {
          body.presentation_uri = args.presentationUri;
        }
        if (args.dtmfSequence) body.dtmf_sequence = args.dtmfSequence;
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/automatic_participant/`, g, {
          method: "POST",
          body,
        });

        context.logger.info(
          "Created auto-recording on VMR '{vmr}' → {uri}",
          { vmr: args.vmrName, uri: args.rtmpUri },
        );

        return {
          data: {
            attributes: {
              vmrName: args.vmrName,
              rtmpUri: args.rtmpUri,
              streaming: true,
            },
            name: `auto-recording-${sanitizeId(args.vmrName)}`,
          },
        };
      },
    },

    deleteAutoRecording: {
      description:
        "Remove an automatic RTMP recording configuration from a VMR.",
      arguments: z.object({
        vmrName: z.string().describe("VMR name"),
        rtmpUri: z
          .string()
          .describe("RTMP URI to remove (matches the alias field)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        const vmrs = await pexipListAll(`${CONFIG_BASE}/conference/`, g, {
          name: args.vmrName,
        });
        if (vmrs.length === 0) {
          throw new Error(`VMR '${args.vmrName}' not found`);
        }

        const autoParticipants = await pexipListAll(
          `${CONFIG_BASE}/automatic_participant/`,
          g,
          { conference: vmrs[0].resource_uri as string },
        );

        const recording = autoParticipants.find(
          (p) => p.alias === args.rtmpUri,
        );
        if (!recording) {
          throw new Error(
            `No auto-recording found on VMR '${args.vmrName}' with URI '${args.rtmpUri}'`,
          );
        }

        await pexipApi(recording.resource_uri as string, g, {
          method: "DELETE",
        });

        context.logger.info(
          "Deleted auto-recording from VMR '{vmr}': {uri}",
          { vmr: args.vmrName, uri: args.rtmpUri },
        );

        return {
          data: {
            attributes: {
              deleted: true,
              vmrName: args.vmrName,
              rtmpUri: args.rtmpUri,
            },
            name: `deleted-recording-${sanitizeId(args.vmrName)}`,
          },
        };
      },
    },

    // --- Streaming credentials ---

    listStreamingCredentials: {
      description:
        "List streaming credentials (public keys used by Pexip's streaming service for authentication).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const creds = await pexipListAll(
          `${CONFIG_BASE}/pexip_streaming_credential/`,
          g,
        );

        context.logger.info("Found {count} streaming credentials", {
          count: creds.length,
        });

        return {
          data: {
            attributes: { credentials: creds, count: creds.length },
            name: "streaming-credentials",
          },
        };
      },
    },

    // --- Media library (recorded content) ---

    listRecordings: {
      description:
        "List all media library entries (recordings, hold music, IVR audio, playback content stored on the management node).",
      arguments: z.object({
        nameFilter: z
          .string()
          .optional()
          .describe("Filter by name substring"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.nameFilter) params.name__contains = args.nameFilter;

        const media = await pexipListAll(
          `${CONFIG_BASE}/media_library/`,
          g,
          params,
        );

        context.logger.info("Found {count} media library entries", {
          count: media.length,
        });

        return {
          data: {
            attributes: { media, count: media.length },
            name: "media-library",
          },
        };
      },
    },

    deleteRecording: {
      description: "Delete a media library entry by name.",
      arguments: z.object({
        name: z.string().describe("Media entry name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const media = await pexipListAll(
          `${CONFIG_BASE}/media_library/`,
          g,
          { name: args.name },
        );

        if (media.length === 0) {
          throw new Error(`Media entry '${args.name}' not found`);
        }

        const uri = media[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted media entry '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-media-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full recording inventory: auto-recording configurations, streaming credentials, and media library entries.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [autoParticipants, streamingCreds, media] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/automatic_participant/`, g),
          pexipListAll(`${CONFIG_BASE}/pexip_streaming_credential/`, g),
          pexipListAll(`${CONFIG_BASE}/media_library/`, g),
        ]);

        const recordings = autoParticipants.filter(
          (p) =>
            p.protocol === "rtmp" ||
            p.streaming === true ||
            (p.alias as string)?.startsWith("rtmp"),
        );

        context.logger.info(
          "Recording inventory: {recordings} auto-recordings, {creds} credentials, {media} media entries",
          {
            recordings: recordings.length,
            creds: streamingCreds.length,
            media: media.length,
          },
        );

        return {
          data: {
            attributes: {
              autoRecordings: recordings,
              totalAutoParticipants: autoParticipants.length,
              streamingCredentials: streamingCreds,
              mediaLibrary: media,
            },
            name: "recording-inventory",
          },
        };
      },
    },
  },
};
