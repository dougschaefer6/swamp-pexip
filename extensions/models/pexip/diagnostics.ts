import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  HISTORY_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
  STATUS_BASE,
} from "./_client.ts";

/**
 * Pexip Infinity diagnostics, health monitoring, and troubleshooting.
 *
 * Aggregates status, alarm, history, and node health data for operational
 * visibility. Complements pexip-log-tools (https://github.com/pexip/pexip-log-tools)
 * which processes diagnostic snapshots offline.
 *
 * Data sources:
 *   - Status API (/api/admin/status/v1/) — real-time node health, active calls
 *   - History API (/api/admin/history/v1/) — CDR records, participant details
 *   - Configuration API — alarms, log levels, system tuneables
 *   - Command API — diagnostic snapshots, backups
 *
 * Docs:
 *   - Status API: https://docs.pexip.com/api_manage/api_status.htm
 *   - History API: https://docs.pexip.com/api_manage/api_history.htm
 *   - Log tools: https://github.com/pexip/pexip-log-tools
 */

export const model = {
  type: "@dougschaefer/pexip-diagnostics",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Real-time health ---

    healthCheck: {
      description:
        "Comprehensive platform health check: node status, active alarms, license usage, and current call load.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [nodeStatus, alarms, licensing] = await Promise.all([
          pexipListAll(`${STATUS_BASE}/worker_vm/`, g),
          pexipListAll(`${STATUS_BASE}/alarm/`, g),
          pexipApi(`${STATUS_BASE}/licensing/`, g) as Promise<
            Record<string, unknown>
          >,
        ]);

        const onlineNodes = nodeStatus.filter(
          (n) => n.status === "active",
        );
        const offlineNodes = nodeStatus.filter(
          (n) => n.status !== "active",
        );
        const criticalAlarms = alarms.filter(
          (a) => a.level === "error" || a.level === "critical",
        );

        const healthy = offlineNodes.length === 0 &&
          criticalAlarms.length === 0;

        context.logger.info(
          "Health: {status} — {online}/{total} nodes online, {alarms} alarms ({critical} critical)",
          {
            status: healthy ? "HEALTHY" : "DEGRADED",
            online: onlineNodes.length,
            total: nodeStatus.length,
            alarms: alarms.length,
            critical: criticalAlarms.length,
          },
        );

        return {
          data: {
            attributes: {
              healthy,
              status: healthy ? "HEALTHY" : "DEGRADED",
              nodes: {
                total: nodeStatus.length,
                online: onlineNodes.length,
                offline: offlineNodes.map((n) => ({
                  name: n.name,
                  status: n.status,
                })),
              },
              alarms: {
                total: alarms.length,
                critical: criticalAlarms,
                all: alarms,
              },
              licensing,
              checkedAt: new Date().toISOString(),
            },
            name: "health-check",
          },
        };
      },
    },

    getNodeHealth: {
      description:
        "Detailed health status for all worker nodes: media load, signaling load, current calls, version, uptime.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const nodes = await pexipListAll(`${STATUS_BASE}/worker_vm/`, g);

        context.logger.info("Retrieved status for {count} nodes", {
          count: nodes.length,
        });

        return {
          data: {
            attributes: { nodes, count: nodes.length },
            name: "node-health",
          },
        };
      },
    },

    // --- Alarms ---

    listAlarms: {
      description:
        "List all active platform alarms with severity, node, and description.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const alarms = await pexipListAll(`${STATUS_BASE}/alarm/`, g);

        context.logger.info("Found {count} active alarms", {
          count: alarms.length,
        });

        return {
          data: {
            attributes: { alarms, count: alarms.length },
            name: "alarms",
          },
        };
      },
    },

    // --- Call history and CDR ---

    getCallHistory: {
      description:
        "Get conference call history for a time range. Returns CDR records with duration, participant count, and service type.",
      arguments: z.object({
        hoursBack: z
          .number()
          .default(24)
          .describe("How many hours of history to retrieve (default: 24)"),
        nameFilter: z
          .string()
          .optional()
          .describe("Filter by conference name substring"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const since = new Date(
          Date.now() - args.hoursBack * 60 * 60 * 1000,
        ).toISOString();

        const params: Record<string, string> = {
          start_time__gte: since,
        };
        if (args.nameFilter) params.name__contains = args.nameFilter;

        const history = await pexipListAll(
          `${HISTORY_BASE}/conference/`,
          g,
          params,
        );

        context.logger.info(
          "Found {count} conferences in the last {hours}h",
          { count: history.length, hours: args.hoursBack },
        );

        return {
          data: {
            attributes: {
              conferences: history,
              count: history.length,
              since,
              hoursBack: args.hoursBack,
            },
            name: "call-history",
          },
        };
      },
    },

    getParticipantHistory: {
      description:
        "Get participant-level CDR records for a time range with codec, quality metrics, and disconnect reasons.",
      arguments: z.object({
        hoursBack: z
          .number()
          .default(24)
          .describe("Hours of history to retrieve"),
        conferenceFilter: z
          .string()
          .optional()
          .describe("Filter by conference name"),
        disconnectReasonFilter: z
          .string()
          .optional()
          .describe("Filter by disconnect reason (e.g., 'Overbandwidth')"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const since = new Date(
          Date.now() - args.hoursBack * 60 * 60 * 1000,
        ).toISOString();

        const params: Record<string, string> = {
          start_time__gte: since,
        };
        if (args.conferenceFilter) {
          params.conference__name__contains = args.conferenceFilter;
        }
        if (args.disconnectReasonFilter) {
          params.disconnect_reason = args.disconnectReasonFilter;
        }

        const participants = await pexipListAll(
          `${HISTORY_BASE}/participant/`,
          g,
          params,
        );

        context.logger.info(
          "Found {count} participant records in the last {hours}h",
          { count: participants.length, hours: args.hoursBack },
        );

        return {
          data: {
            attributes: {
              participants,
              count: participants.length,
              since,
            },
            name: "participant-history",
          },
        };
      },
    },

    // --- Quality analysis ---

    qualityReport: {
      description:
        "Analyze call quality over a time range: disconnect reasons, packet loss, protocol distribution, and problem calls.",
      arguments: z.object({
        hoursBack: z
          .number()
          .default(24)
          .describe("Hours of history to analyze"),
        packetLossThreshold: z
          .number()
          .default(2)
          .describe(
            "Packet loss percentage above which a call is flagged as poor quality",
          ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const since = new Date(
          Date.now() - args.hoursBack * 60 * 60 * 1000,
        ).toISOString();

        const participants = await pexipListAll(
          `${HISTORY_BASE}/participant/`,
          g,
          { start_time__gte: since },
        );

        // Analyze disconnect reasons
        const disconnectReasons: Record<string, number> = {};
        const protocols: Record<string, number> = {};
        const problemCalls: Array<Record<string, unknown>> = [];

        for (const p of participants) {
          // Count disconnect reasons
          const reason = (p.disconnect_reason as string) || "unknown";
          disconnectReasons[reason] = (disconnectReasons[reason] || 0) + 1;

          // Count protocols
          const proto = (p.protocol as string) || "unknown";
          protocols[proto] = (protocols[proto] || 0) + 1;

          // Flag quality issues
          const packetLoss = p.rx_packet_loss as number;
          if (
            packetLoss !== undefined &&
            packetLoss > args.packetLossThreshold
          ) {
            problemCalls.push({
              displayName: p.display_name,
              conference: p.conference,
              protocol: p.protocol,
              packetLoss,
              disconnectReason: reason,
              duration: p.duration,
            });
          }
        }

        const normalDisconnects =
          (disconnectReasons["Call disconnected"] || 0) +
          (disconnectReasons["Conference ended"] || 0);
        const abnormalDisconnects = participants.length - normalDisconnects;

        context.logger.info(
          "Quality report: {total} calls, {problems} with quality issues, {abnormal} abnormal disconnects",
          {
            total: participants.length,
            problems: problemCalls.length,
            abnormal: abnormalDisconnects,
          },
        );

        return {
          data: {
            attributes: {
              period: { since, hoursBack: args.hoursBack },
              totalParticipants: participants.length,
              disconnectReasons,
              normalDisconnects,
              abnormalDisconnects,
              protocolDistribution: protocols,
              problemCalls,
              packetLossThreshold: args.packetLossThreshold,
              analyzedAt: new Date().toISOString(),
            },
            name: "quality-report",
          },
        };
      },
    },

    // --- Log levels ---

    listLogLevels: {
      description: "List all configurable log levels on the platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const levels = await pexipListAll(
          `${CONFIG_BASE}/log_level/`,
          g,
        );

        context.logger.info("Found {count} log level entries", {
          count: levels.length,
        });

        return {
          data: {
            attributes: { logLevels: levels, count: levels.length },
            name: "log-levels",
          },
        };
      },
    },

    setLogLevel: {
      description:
        "Set the log level for a specific component (for debugging).",
      arguments: z.object({
        name: z
          .string()
          .describe("Log component name (e.g., 'admin.external_policy')"),
        level: z
          .enum(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"])
          .describe("Log level"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const levels = await pexipListAll(
          `${CONFIG_BASE}/log_level/`,
          g,
          { name: args.name },
        );

        if (levels.length > 0) {
          const uri = levels[0].resource_uri as string;
          await pexipApi(uri, g, {
            method: "PATCH",
            body: { level: args.level },
          });
        } else {
          await pexipApi(`${CONFIG_BASE}/log_level/`, g, {
            method: "POST",
            body: { name: args.name, level: args.level },
          });
        }

        context.logger.info("Set log level {name} → {level}", {
          name: args.name,
          level: args.level,
        });

        return {
          data: {
            attributes: { name: args.name, level: args.level },
            name: `log-level-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- System tuneables ---

    listTuneables: {
      description:
        "List all system tuneables (advanced configuration parameters).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tuneables = await pexipListAll(
          `${CONFIG_BASE}/system_tuneable/`,
          g,
        );

        context.logger.info("Found {count} system tuneables", {
          count: tuneables.length,
        });

        return {
          data: {
            attributes: { tuneables, count: tuneables.length },
            name: "system-tuneables",
          },
        };
      },
    },

    setTuneable: {
      description:
        "Set a system tuneable value. Use with caution — these are advanced parameters.",
      arguments: z.object({
        name: z.string().describe("Tuneable name"),
        setting: z.string().describe("Value to set"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const tuneables = await pexipListAll(
          `${CONFIG_BASE}/system_tuneable/`,
          g,
          { name: args.name },
        );

        if (tuneables.length > 0) {
          const uri = tuneables[0].resource_uri as string;
          await pexipApi(uri, g, {
            method: "PATCH",
            body: { setting: args.setting },
          });
        } else {
          await pexipApi(`${CONFIG_BASE}/system_tuneable/`, g, {
            method: "POST",
            body: { name: args.name, setting: args.setting },
          });
        }

        context.logger.info("Set tuneable {name} = {setting}", {
          name: args.name,
          setting: args.setting,
        });

        return {
          data: {
            attributes: { name: args.name, setting: args.setting },
            name: `tuneable-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Snapshot ---

    takeSnapshot: {
      description:
        "Take a diagnostic snapshot for Pexip support. Captures logs, configuration, and runtime state.",
      arguments: z.object({
        logDuration: z
          .number()
          .default(10)
          .describe("Minutes of log history to include (default: 10)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        const result = await pexipApi(
          "/api/admin/command/v1/platform/take_snapshot/",
          g,
          {
            method: "POST",
            body: { log_duration: args.logDuration },
          },
        );

        context.logger.info("Diagnostic snapshot initiated ({minutes}m logs)", {
          minutes: args.logDuration,
        });

        return {
          data: {
            attributes: {
              initiated: true,
              logDuration: args.logDuration,
              result,
              timestamp: new Date().toISOString(),
            },
            name: "diagnostic-snapshot",
          },
        };
      },
    },
  },
};
