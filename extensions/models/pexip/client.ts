import { z } from "npm:zod@4.3.6";
import { sanitizeId } from "./_client.ts";

/**
 * Pexip Infinity Client REST API — participant-level conference control.
 *
 * This model connects to conferencing nodes (not the management node) using
 * the Client REST API at /api/client/v2/conferences/<alias>/. It operates
 * from the perspective of a participant, authenticated via token.
 *
 * The flow is:
 *   1. Request a token with requestToken (alias + display name + optional PIN)
 *   2. Use the token for all subsequent operations
 *   3. Refresh the token before it expires
 *   4. Release the token when done
 *
 * This API is what custom meeting UIs, virtual lobbies, and automation
 * clients use to interact with active conferences. It provides:
 *   - Real-time participant roster
 *   - Conference and participant control (mute, lock, layout, spotlight)
 *   - Chat and messaging
 *   - Breakout room management
 *   - Presentation control
 *   - DTMF tone sending
 *   - Far-end camera control
 *
 * The SSE event stream at /events provides real-time reactive data for
 * building custom UIs or event-driven automations.
 *
 * NPM packages for building full clients:
 *   @pexip/infinity, @pexip/infinity-api, @pexip/peer-connection,
 *   @pexip/media, @pexip/media-control, @pexip/plugin-api
 *
 * Docs: https://docs.pexip.com/api_client/api_rest.htm
 * Developer portal: https://developer.pexip.com/docs/infinity/introduction
 */

const ClientGlobalArgsSchema = z.object({
  nodeHost: z
    .string()
    .describe(
      "Pexip conferencing node FQDN or IP (not the management node)",
    ),
  verifySsl: z
    .boolean()
    .default(true)
    .describe("Verify TLS certificate"),
});

async function clientApi(
  nodeHost: string,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    token?: string;
    pin?: string;
  },
): Promise<{ status: number; data: unknown }> {
  const url = `https://${nodeHost}${path}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (options?.token) {
    headers["token"] = options.token;
  }

  if (options?.pin !== undefined) {
    headers["pin"] = options.pin;
  }

  const fetchOptions: RequestInit = {
    method: options?.method || "POST",
    headers,
  };

  if (options?.body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url, fetchOptions);
  const contentType = resp.headers.get("content-type") || "";

  let data: unknown = null;
  if (contentType.includes("application/json")) {
    data = await resp.json();
  } else {
    data = await resp.text();
  }

  if (!resp.ok && resp.status !== 403) {
    throw new Error(
      `Client API ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`,
    );
  }

  return { status: resp.status, data };
}

export const model = {
  type: "@dougschaefer/pexip-client",
  version: "2026.03.29.1",
  globalArguments: ClientGlobalArgsSchema,

  methods: {
    // --- Token management ---

    requestToken: {
      description:
        "Request an authentication token for a conference. Returns the token, its expiry, and conference details including whether a PIN is required.",
      arguments: z.object({
        conferenceAlias: z
          .string()
          .describe("Conference alias to join (e.g., meet.12345)"),
        displayName: z
          .string()
          .default("swamp-client")
          .describe("Display name for the participant"),
        pin: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe(
            "Conference PIN (host or guest). Omit to check PIN requirements.",
          ),
        chosenIdp: z
          .string()
          .optional()
          .describe("Identity provider UUID for SSO authentication"),
        ssoToken: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("SSO token from identity provider redirect"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          display_name: args.displayName,
        };
        const options: { method: string; body: unknown; pin?: string } = {
          method: "POST",
          body,
        };

        if (args.pin !== undefined) {
          options.pin = args.pin;
        }
        if (args.chosenIdp) {
          body.chosen_idp = args.chosenIdp;
        }
        if (args.ssoToken) {
          body.sso_token = args.ssoToken;
        }

        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/request_token`;

        const result = await clientApi(g.nodeHost, path, options);
        const data = result.data as Record<string, unknown>;

        if (result.status === 403) {
          context.logger.info(
            "PIN required for '{alias}': {pinRequired}",
            {
              alias: args.conferenceAlias,
              pinRequired: JSON.stringify(data),
            },
          );

          return {
            data: {
              attributes: {
                authenticated: false,
                pinRequired: true,
                conferenceAlias: args.conferenceAlias,
                details: data,
              },
              name: `token-${sanitizeId(args.conferenceAlias)}`,
            },
          };
        }

        context.logger.info(
          "Token acquired for '{alias}', expires in {expires}s",
          {
            alias: args.conferenceAlias,
            expires: data.expires ?? "unknown",
          },
        );

        return {
          data: {
            attributes: {
              authenticated: true,
              token: data.token,
              expires: data.expires,
              conferenceAlias: args.conferenceAlias,
              participantUuid: data.participant_uuid,
              displayName: args.displayName,
              role: data.role,
              conferenceName: data.conference_name,
              analyticsEnabled: data.analytics_enabled,
              chatEnabled: data.chat_enabled,
              guestsMuted: data.guests_muted,
              locked: data.locked,
              started: data.started,
              liveCaptionsAvailable: data.live_captions_available,
            },
            name: `token-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    refreshToken: {
      description:
        "Refresh an authentication token before it expires. Returns a new token with a fresh expiry.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Current token to refresh"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/refresh_token`;

        const result = await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        const data = result.data as Record<string, unknown>;

        context.logger.info("Token refreshed, expires in {expires}s", {
          expires: data.expires ?? "unknown",
        });

        return {
          data: {
            attributes: {
              token: data.token,
              expires: data.expires,
            },
            name: `token-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    releaseToken: {
      description:
        "Release an authentication token and disconnect from the conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Token to release"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/release_token`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        context.logger.info("Token released for '{alias}'", {
          alias: args.conferenceAlias,
        });

        return {
          data: {
            attributes: {
              released: true,
              conferenceAlias: args.conferenceAlias,
            },
            name: `released-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    // --- Conference control ---

    getParticipants: {
      description:
        "List all participants in an active conference with role, protocol, mute state, and media info.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/participants`;

        const result = await clientApi(g.nodeHost, path, {
          method: "GET",
          token: args.token,
        });

        const data = result.data as Array<Record<string, unknown>>;

        context.logger.info("Conference '{alias}' has {count} participants", {
          alias: args.conferenceAlias,
          count: Array.isArray(data) ? data.length : 0,
        });

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              participants: data,
              count: Array.isArray(data) ? data.length : 0,
            },
            name: `participants-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    sendMessage: {
      description: "Send a chat message to all participants in the conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        message: z.string().describe("Message text to send"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/message`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
          body: { payload: args.message, type: "text/plain" },
        });

        context.logger.info("Sent message to '{alias}'", {
          alias: args.conferenceAlias,
        });

        return {
          data: {
            attributes: {
              sent: true,
              conferenceAlias: args.conferenceAlias,
            },
            name: `message-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    lock: {
      description: "Lock or unlock a conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        locked: z.boolean().describe("True to lock, false to unlock"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const action = args.locked ? "lock" : "unlock";
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/${action}`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        context.logger.info("{action} conference '{alias}'", {
          action: action.charAt(0).toUpperCase() + action.slice(1) + "ed",
          alias: args.conferenceAlias,
        });

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              locked: args.locked,
            },
            name: `lock-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    muteGuests: {
      description: "Mute or unmute all guest participants.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        muted: z.boolean().describe("True to mute, false to unmute"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const action = args.muted ? "muteguests" : "unmuteguests";
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/${action}`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        context.logger.info("{action} guests in '{alias}'", {
          action: args.muted ? "Muted" : "Unmuted",
          alias: args.conferenceAlias,
        });

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              guestsMuted: args.muted,
            },
            name: `mute-guests-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    setLayout: {
      description:
        "Change the video layout for all participants. Layouts: 1:0, 1:7, 1:21, 2:21, 1:33, teams, ac, 2x2, 3x3, 4x4, 5x5.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        layout: z
          .enum([
            "1:0",
            "1:7",
            "1:21",
            "2:21",
            "1:33",
            "teams",
            "ac",
            "2x2",
            "3x3",
            "4x4",
            "5x5",
          ])
          .describe("Layout name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/transform_layout`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
          body: { layout: args.layout },
        });

        context.logger.info("Set layout to '{layout}' in '{alias}'", {
          layout: args.layout,
          alias: args.conferenceAlias,
        });

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              layout: args.layout,
            },
            name: `layout-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    // --- Participant control ---

    admitParticipant: {
      description: "Admit a waiting participant into a locked conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        participantUuid: z
          .string()
          .describe("UUID of the participant to admit"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/participants/${args.participantUuid}/unlock`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        context.logger.info("Admitted participant {uuid}", {
          uuid: args.participantUuid,
        });

        return {
          data: {
            attributes: {
              admitted: true,
              participantUuid: args.participantUuid,
            },
            name: `admit-${sanitizeId(args.participantUuid)}`,
          },
        };
      },
    },

    spotlightParticipant: {
      description:
        "Spotlight a participant, pinning them as the main speaker in the layout.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        participantUuid: z
          .string()
          .describe("UUID of the participant to spotlight"),
        enable: z
          .boolean()
          .default(true)
          .describe("True to spotlight, false to remove spotlight"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const action = args.enable ? "spotlight" : "unspotlight";
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/participants/${args.participantUuid}/${action}`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
        });

        context.logger.info("{action} participant {uuid}", {
          action: args.enable ? "Spotlighted" : "Unspotlighted",
          uuid: args.participantUuid,
        });

        return {
          data: {
            attributes: {
              participantUuid: args.participantUuid,
              spotlighted: args.enable,
            },
            name: `spotlight-${sanitizeId(args.participantUuid)}`,
          },
        };
      },
    },

    dial: {
      description:
        "Dial out from the conference to a SIP/H.323/RTMP destination and add it as a participant. Use protocol 'rtmp' with an RTMP URI to start streaming.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        destination: z
          .string()
          .describe(
            "SIP URI, H.323 alias, or RTMP URL to dial",
          ),
        protocol: z
          .enum(["sip", "h323", "rtmp", "mssip", "auto"])
          .default("auto")
          .describe("Protocol to use for the outbound call"),
        role: z
          .enum(["chair", "guest"])
          .default("guest")
          .describe("Role to assign the dialed participant"),
        presentationUri: z
          .string()
          .optional()
          .describe("Separate RTMP URI for the presentation stream"),
        streaming: z
          .boolean()
          .optional()
          .describe("Mark this participant as a streaming/recording endpoint"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/dial`;

        const body: Record<string, unknown> = {
          destination: args.destination,
          protocol: args.protocol,
          role: args.role,
        };
        if (args.presentationUri) {
          body.presentation_uri = args.presentationUri;
        }
        if (args.streaming !== undefined) {
          body.streaming = args.streaming;
        }

        const result = await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
          body,
        });

        context.logger.info(
          "Dialed {destination} ({protocol}) into '{alias}'",
          {
            destination: args.destination,
            protocol: args.protocol,
            alias: args.conferenceAlias,
          },
        );

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              destination: args.destination,
              protocol: args.protocol,
              result: result.data,
            },
            name: `dial-${sanitizeId(args.destination)}`,
          },
        };
      },
    },

    disconnect: {
      description: "Disconnect a participant or end the entire conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        participantUuid: z
          .string()
          .optional()
          .describe(
            "UUID of participant to disconnect. Omit to disconnect all (end conference).",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        if (args.participantUuid) {
          const path = `/api/client/v2/conferences/${
            encodeURIComponent(args.conferenceAlias)
          }/participants/${args.participantUuid}/disconnect`;

          await clientApi(g.nodeHost, path, {
            method: "POST",
            token: args.token,
          });

          context.logger.info("Disconnected participant {uuid}", {
            uuid: args.participantUuid,
          });
        } else {
          const path = `/api/client/v2/conferences/${
            encodeURIComponent(args.conferenceAlias)
          }/disconnect`;

          await clientApi(g.nodeHost, path, {
            method: "POST",
            token: args.token,
          });

          context.logger.info("Disconnected all participants in '{alias}'", {
            alias: args.conferenceAlias,
          });
        }

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              participantUuid: args.participantUuid || "all",
              disconnected: true,
            },
            name: `disconnect-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    // --- Breakout rooms ---

    listBreakouts: {
      description: "List active breakout rooms in a conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/breakouts`;

        const result = await clientApi(g.nodeHost, path, {
          method: "GET",
          token: args.token,
        });

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              breakouts: result.data,
            },
            name: `breakouts-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },

    // --- Text overlay ---

    setOverlayText: {
      description:
        "Set a text overlay banner visible to all participants in the conference.",
      arguments: z.object({
        conferenceAlias: z.string().describe("Conference alias"),
        token: z
          .string()
          .meta({ sensitive: true })
          .describe("Authentication token"),
        text: z
          .string()
          .describe("Text to display as overlay (empty string to clear)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const path = `/api/client/v2/conferences/${
          encodeURIComponent(args.conferenceAlias)
        }/overlaytext`;

        await clientApi(g.nodeHost, path, {
          method: "POST",
          token: args.token,
          body: { text: args.text },
        });

        context.logger.info(
          args.text
            ? "Set overlay text in '{alias}'"
            : "Cleared overlay text in '{alias}'",
          { alias: args.conferenceAlias },
        );

        return {
          data: {
            attributes: {
              conferenceAlias: args.conferenceAlias,
              overlayText: args.text,
            },
            name: `overlay-${sanitizeId(args.conferenceAlias)}`,
          },
        };
      },
    },
  },
};
