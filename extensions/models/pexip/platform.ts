import { z } from "npm:zod@4.3.6";
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
 * Pexip Infinity platform administration — global system configuration,
 * worker node management, DNS/NTP servers, system locations, license status,
 * alarms, backups, upgrades, diagnostic snapshots, and cloud bursting.
 *
 * Docs: https://docs.pexip.com/admin/admin_intro.htm
 * Status API: https://docs.pexip.com/api_manage/api_status.htm
 * Command API: https://docs.pexip.com/api_manage/api_command.htm
 */

// --- Resource schemas ---

const SystemConfigSchema = z
  .object({
    resource_uri: z.string().optional(),
    name: z.string(),
    dns_servers: z.array(z.string()).optional(),
    ntp_servers: z.array(z.string()).optional(),
    sip_domain: z.string().optional(),
    h323_gatekeeper_id: z.string().optional(),
    enable_sip: z.boolean().optional(),
    enable_h323: z.boolean().optional(),
    enable_webrtc: z.boolean().optional(),
    global_proxying_mode: z.string().optional(),
    primary_admin_web_address: z.string().optional(),
  })
  .passthrough();

const WorkerNodeSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    hostname: z.string(),
    system_location: z.string().optional(),
    role: z.string().optional(),
    maintenance_mode: z.boolean().optional(),
    version: z.string().optional(),
    last_reported: z.string().optional(),
    media_load: z.number().optional(),
    signaling_load: z.number().optional(),
    current_calls: z.number().optional(),
  })
  .passthrough();

const SystemLocationSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    policy_server_url: z.string().optional(),
    event_sink_url: z.string().optional(),
    sip_proxy: z.string().optional(),
    h323_gatekeeper: z.string().optional(),
    dns_server: z.string().optional(),
    ntp_server: z.string().optional(),
    overflow_location1: z.string().optional(),
    overflow_location2: z.string().optional(),
  })
  .passthrough();

const LicenseStatusSchema = z
  .object({
    total_licenses: z.number().optional(),
    used_licenses: z.number().optional(),
    available_licenses: z.number().optional(),
    license_type: z.string().optional(),
    expiry: z.string().optional(),
  })
  .passthrough();

const AlarmSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    instance: z.string().optional(),
    node: z.string().optional(),
    time_raised: z.string().optional(),
    details: z.string().optional(),
  })
  .passthrough();

const BackupSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    filename: z.string().optional(),
    created: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

export const model = {
  type: "@dougschaefer/pexip-platform",
  version: "2026.03.26.1",
  globalArguments: PexipGlobalArgsSchema,
  resources: {
    systemConfig: {
      description: "Pexip Infinity global system configuration",
      schema: SystemConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    workerNode: {
      description: "Conferencing or proxying node registered to the platform",
      schema: WorkerNodeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    systemLocation: {
      description: "System location (logical grouping for nodes)",
      schema: SystemLocationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    licenseStatus: {
      description: "Current license status and usage",
      schema: LicenseStatusSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    alarm: {
      description: "Active platform alarm",
      schema: AlarmSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
    backup: {
      description: "Platform configuration backup",
      schema: BackupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    // --- System configuration ---

    getConfig: {
      description:
        "Get the global system configuration (DNS, NTP, SIP domain, protocols).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        // Global config is a singleton at /api/admin/configuration/v1/global/
        const result = (await pexipApi(
          `${CONFIG_BASE}/global/`,
          g,
        )) as Record<string, unknown>;

        const handle = await context.writeResource(
          "systemConfig",
          "global",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    updateConfig: {
      description:
        "Update global system configuration. Pass only fields to change.",
      arguments: z.object({
        sipDomain: z.string().optional().describe("Default SIP domain"),
        enableSip: z.boolean().optional().describe("Enable SIP protocol"),
        enableH323: z.boolean().optional().describe("Enable H.323 protocol"),
        enableWebrtc: z.boolean().optional().describe("Enable WebRTC"),
        dnsServers: z
          .array(z.string())
          .optional()
          .describe("DNS server addresses"),
        ntpServers: z
          .array(z.string())
          .optional()
          .describe("NTP server addresses"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {};
        if (args.sipDomain !== undefined) body.sip_domain = args.sipDomain;
        if (args.enableSip !== undefined) body.enable_sip = args.enableSip;
        if (args.enableH323 !== undefined) body.enable_h323 = args.enableH323;
        if (args.enableWebrtc !== undefined) {
          body.enable_webrtc = args.enableWebrtc;
        }
        if (args.dnsServers !== undefined) body.dns_servers = args.dnsServers;
        if (args.ntpServers !== undefined) body.ntp_servers = args.ntpServers;

        await pexipApi(`${CONFIG_BASE}/global/`, g, {
          method: "PATCH",
          body,
        });

        context.logger.info("Updated global configuration");

        const result = (await pexipApi(
          `${CONFIG_BASE}/global/`,
          g,
        )) as Record<string, unknown>;

        const handle = await context.writeResource(
          "systemConfig",
          "global",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Worker nodes (conferencing + proxying) ---

    listNodes: {
      description:
        "List all conferencing and proxying nodes registered to this platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const nodes = await pexipListAll(
          `${CONFIG_BASE}/worker_vm/`,
          g,
        );

        context.logger.info("Found {count} worker nodes", {
          count: nodes.length,
        });

        const handles = [];
        for (const node of nodes) {
          const handle = await context.writeResource(
            "workerNode",
            sanitizeId(node.name as string),
            node,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getNodeStatus: {
      description:
        "Get runtime status of all worker nodes (load, calls, version).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const statuses = await pexipListAll(
          `${STATUS_BASE}/worker_vm/`,
          g,
        );

        context.logger.info("Got status for {count} nodes", {
          count: statuses.length,
        });

        const handles = [];
        for (const status of statuses) {
          const handle = await context.writeResource(
            "workerNode",
            sanitizeId((status.name as string) + "-status"),
            status,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    setMaintenanceMode: {
      description:
        "Enable or disable maintenance mode on a conferencing node. Drains calls before maintenance.",
      arguments: z.object({
        nodeName: z.string().describe("Name of the worker node"),
        enabled: z
          .boolean()
          .describe("true to enable maintenance mode, false to disable"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        // Find the node to get its ID
        const nodes = await pexipListAll(
          `${CONFIG_BASE}/worker_vm/`,
          g,
        );
        const node = nodes.find((n) => n.name === args.nodeName);
        if (!node) throw new Error(`Node not found: ${args.nodeName}`);

        const nodeId = extractId(node.resource_uri as string);
        await pexipApi(`${CONFIG_BASE}/worker_vm/${nodeId}/`, g, {
          method: "PATCH",
          body: { maintenance_mode: args.enabled },
        });

        context.logger.info(
          "{action} maintenance mode on {node}",
          {
            action: args.enabled ? "Enabled" : "Disabled",
            node: args.nodeName,
          },
        );

        return { dataHandles: [] };
      },
    },

    // --- DNS and NTP servers ---

    listDnsServers: {
      description: "List configured DNS servers.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(`${CONFIG_BASE}/dns_server/`, g);
        context.logger.info("Found {count} DNS servers", {
          count: servers.length,
        });
        return { dataHandles: [] };
      },
    },

    addDnsServer: {
      description: "Add a DNS server.",
      arguments: z.object({
        address: z.string().describe("DNS server IP address"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/dns_server/`, g, {
          method: "POST",
          body: { address: args.address },
        });
        context.logger.info("Added DNS server {addr}", { addr: args.address });
        return { dataHandles: [] };
      },
    },

    listNtpServers: {
      description: "List configured NTP servers.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(`${CONFIG_BASE}/ntp_server/`, g);
        context.logger.info("Found {count} NTP servers", {
          count: servers.length,
        });
        return { dataHandles: [] };
      },
    },

    addNtpServer: {
      description: "Add an NTP server.",
      arguments: z.object({
        address: z.string().describe("NTP server address (IP or FQDN)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/ntp_server/`, g, {
          method: "POST",
          body: { address: args.address },
        });
        context.logger.info("Added NTP server {addr}", { addr: args.address });
        return { dataHandles: [] };
      },
    },

    // --- Participant media stats ---

    getParticipantMedia: {
      description:
        "Get media stream statistics for a participant (bitrate, codec, packet loss, jitter).",
      arguments: z.object({
        participantId: z.string().describe("Participant ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const streams = await pexipListAll(
          `${STATUS_BASE}/participant/${args.participantId}/media_stream/`,
          g,
        );
        context.logger.info("Got {count} media streams for participant {pid}", {
          count: streams.length,
          pid: args.participantId,
        });
        return { dataHandles: [] };
      },
    },

    // --- Node statistics ---

    getNodeStatistics: {
      description: "Get detailed load statistics for a specific worker node.",
      arguments: z.object({
        nodeId: z.string().describe("Worker node ID"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const _stats = await pexipListAll(
          `${STATUS_BASE}/worker_vm/${args.nodeId}/statistics/`,
          g,
        );
        context.logger.info("Got statistics for node {id}", {
          id: args.nodeId,
        });
        return { dataHandles: [] };
      },
    },

    // --- System locations ---

    listLocations: {
      description: "List all system locations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const locations = await pexipListAll(
          `${CONFIG_BASE}/system_location/`,
          g,
        );

        context.logger.info("Found {count} system locations", {
          count: locations.length,
        });

        const handles = [];
        for (const loc of locations) {
          const handle = await context.writeResource(
            "systemLocation",
            sanitizeId(loc.name as string),
            loc,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createLocation: {
      description: "Create a new system location.",
      arguments: z.object({
        name: z.string().describe("Location name"),
        description: z.string().optional().describe("Location description"),
        policyServerUrl: z
          .string()
          .optional()
          .describe("External policy server URL"),
        eventSinkUrl: z
          .string()
          .optional()
          .describe("Event sink URL for this location"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };
        if (args.description) body.description = args.description;
        if (args.policyServerUrl) {
          body.policy_server_url = args.policyServerUrl;
        }
        if (args.eventSinkUrl) body.event_sink_url = args.eventSinkUrl;

        await pexipApi(`${CONFIG_BASE}/system_location/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created system location {name}", {
          name: args.name,
        });

        // Fetch back the created location
        const locations = await pexipListAll(
          `${CONFIG_BASE}/system_location/`,
          g,
          { name: args.name },
        );
        const created = locations.find((l) => l.name === args.name);

        if (created) {
          const handle = await context.writeResource(
            "systemLocation",
            sanitizeId(args.name),
            created,
          );
          return { dataHandles: [handle] };
        }
        return { dataHandles: [] };
      },
    },

    // --- Licensing ---

    getLicenseStatus: {
      description: "Get current license status and usage.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const result = (await pexipApi(
          `${STATUS_BASE}/licensing/`,
          g,
        )) as Record<string, unknown>;

        context.logger.info("License status: {*}", result);

        const handle = await context.writeResource(
          "licenseStatus",
          "current",
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    // --- Alarms ---

    listAlarms: {
      description: "List all active platform alarms.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const alarms = await pexipListAll(
          `${STATUS_BASE}/alarm/`,
          g,
        );

        context.logger.info("Found {count} active alarms", {
          count: alarms.length,
        });

        const handles = [];
        for (const alarm of alarms) {
          const handle = await context.writeResource(
            "alarm",
            sanitizeId(`${alarm.name}-${alarm.id}`),
            alarm,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- Backup and restore (Command API) ---

    createBackup: {
      description:
        "Create an encrypted configuration backup on the management node.",
      arguments: z.object({
        passphrase: z
          .string()
          .optional()
          .describe("Encryption passphrase for the backup file"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {};
        if (args.passphrase) body.passphrase = args.passphrase;

        const result = (await pexipApi(
          "/api/admin/command/v1/platform/backup_create/",
          g,
          { method: "POST", body },
        )) as Record<string, unknown>;

        context.logger.info("Backup created");

        const handle = await context.writeResource(
          "backup",
          sanitizeId(`backup-${new Date().toISOString()}`),
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    restoreBackup: {
      description:
        "Restore a configuration backup. WARNING: This overwrites all current configuration.",
      arguments: z.object({
        passphrase: z
          .string()
          .optional()
          .describe("Decryption passphrase for the backup file"),
        backupId: z
          .string()
          .describe("Backup ID to restore"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          package: args.backupId,
        };
        if (args.passphrase) body.passphrase = args.passphrase;

        await pexipApi(
          "/api/admin/command/v1/platform/backup_restore/",
          g,
          { method: "POST", body },
        );

        context.logger.info("Backup restore initiated for {id}", {
          id: args.backupId,
        });

        return { dataHandles: [] };
      },
    },

    // --- Platform commands ---

    upgrade: {
      description:
        "Initiate a platform upgrade. Upload the upgrade package first, then trigger.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/platform/upgrade/",
          g,
          { method: "POST", body: {} },
        );

        context.logger.info("Platform upgrade initiated");
        return { dataHandles: [] };
      },
    },

    takeSnapshot: {
      description:
        "Take a diagnostic snapshot of the platform for Pexip support.",
      arguments: z.object({
        hours: z
          .number()
          .optional()
          .default(1)
          .describe("Hours of log data to include"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/platform/snapshot/",
          g,
          { method: "POST", body: { limit: args.hours } },
        );

        context.logger.info("Diagnostic snapshot initiated ({hours}h)", {
          hours: args.hours,
        });

        return { dataHandles: [] };
      },
    },

    dialParticipant: {
      description: "Dial out to a participant and add them to a conference.",
      arguments: z.object({
        conferenceAlias: z
          .string()
          .describe("Alias of the conference to dial into"),
        destination: z
          .string()
          .describe("SIP URI, H.323 alias, or phone number to dial"),
        role: z
          .enum(["chair", "guest"])
          .optional()
          .default("guest")
          .describe("Participant role"),
        protocol: z
          .enum(["sip", "h323", "rtmp", "mssip", "auto"])
          .optional()
          .default("auto")
          .describe("Protocol to use for the outbound call"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          conference_alias: args.conferenceAlias,
          destination: args.destination,
          role: args.role,
          protocol: args.protocol,
        };

        const _result = await pexipApi(
          "/api/admin/command/v1/participant/dial/",
          g,
          { method: "POST", body },
        );

        context.logger.info("Dialed {dest} into {conf} as {role}", {
          dest: args.destination,
          conf: args.conferenceAlias,
          role: args.role,
        });

        return { dataHandles: [] };
      },
    },

    disconnectConference: {
      description: "Disconnect all participants and end a conference.",
      arguments: z.object({
        conferenceId: z.string().describe("Conference ID to disconnect"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/conference/disconnect/",
          g,
          { method: "POST", body: { conference_id: args.conferenceId } },
        );

        context.logger.info("Disconnected conference {id}", {
          id: args.conferenceId,
        });

        return { dataHandles: [] };
      },
    },

    startCloudNode: {
      description: "Start a dynamic bursting cloud node in Azure.",
      arguments: z.object({
        instanceId: z
          .string()
          .describe("Azure VM instance ID for the overflow node"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/platform/start_cloudnode/",
          g,
          { method: "POST", body: { instance_id: args.instanceId } },
        );

        context.logger.info("Started cloud node {id}", {
          id: args.instanceId,
        });

        return { dataHandles: [] };
      },
    },

    listBackups: {
      description: "List available configuration backups.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const backups = await pexipListAll(
          `${CONFIG_BASE}/system_backup/`,
          g,
        );

        context.logger.info("Found {count} backups", {
          count: backups.length,
        });

        const handles = [];
        for (const backup of backups) {
          const handle = await context.writeResource(
            "backup",
            sanitizeId(backup.filename as string || `backup-${backup.id}`),
            backup,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- Full inventory ---

    inventory: {
      description:
        "Full platform inventory — system config, nodes, locations, licenses, and alarms.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const handles = [];

        // System config
        const config = (await pexipApi(
          `${CONFIG_BASE}/global/`,
          g,
        )) as Record<string, unknown>;
        handles.push(
          await context.writeResource("systemConfig", "global", config),
        );

        // Worker nodes
        const nodes = await pexipListAll(
          `${CONFIG_BASE}/worker_vm/`,
          g,
        );
        for (const node of nodes) {
          handles.push(
            await context.writeResource(
              "workerNode",
              sanitizeId(node.name as string),
              node,
            ),
          );
        }

        // System locations
        const locations = await pexipListAll(
          `${CONFIG_BASE}/system_location/`,
          g,
        );
        for (const loc of locations) {
          handles.push(
            await context.writeResource(
              "systemLocation",
              sanitizeId(loc.name as string),
              loc,
            ),
          );
        }

        // License status
        const license = (await pexipApi(
          `${STATUS_BASE}/licensing/`,
          g,
        )) as Record<string, unknown>;
        handles.push(
          await context.writeResource("licenseStatus", "current", license),
        );

        // Alarms
        const alarms = await pexipListAll(
          `${STATUS_BASE}/alarm/`,
          g,
        );
        for (const alarm of alarms) {
          handles.push(
            await context.writeResource(
              "alarm",
              sanitizeId(`${alarm.name}-${alarm.id}`),
              alarm,
            ),
          );
        }

        context.logger.info(
          "Platform inventory: {nodes} nodes, {locations} locations, {alarms} alarms",
          {
            nodes: nodes.length,
            locations: locations.length,
            alarms: alarms.length,
          },
        );

        return { dataHandles: handles };
      },
    },
  },
};
