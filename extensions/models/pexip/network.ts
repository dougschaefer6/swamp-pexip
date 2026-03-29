import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity network infrastructure — SIP proxies, SIP credentials,
 * MSSIP proxies, H.323 gatekeepers, STUN servers, Teams proxies, SMTP,
 * HTTP proxy, and static routes.
 *
 * These resources define how conferencing nodes connect to external
 * telephony and network infrastructure. They are referenced by VMRs,
 * call routing rules, and system locations.
 */

export const model = {
  type: "@dougschaefer/pexip-network",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- SIP proxies ---

    listSipProxies: {
      description: "List all SIP proxy configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const proxies = await pexipListAll(
          `${CONFIG_BASE}/sip_proxy/`,
          g,
        );
        context.logger.info("Found {count} SIP proxies", {
          count: proxies.length,
        });
        return {
          data: {
            attributes: { proxies, count: proxies.length },
            name: "sip-proxies",
          },
        };
      },
    },

    createSipProxy: {
      description: "Create a SIP proxy (outbound SBC or SIP trunk endpoint).",
      arguments: z.object({
        name: z.string().describe("Proxy name"),
        address: z.string().describe("Proxy address (FQDN or IP)"),
        transport: z
          .enum(["tcp", "udp", "tls"])
          .default("tls")
          .describe("SIP transport protocol"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          transport: args.transport,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/sip_proxy/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created SIP proxy '{name}' → {address}", {
          name: args.name,
          address: args.address,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `sip-proxy-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deleteSipProxy: {
      description: "Delete a SIP proxy configuration.",
      arguments: z.object({
        name: z.string().describe("SIP proxy name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const proxies = await pexipListAll(
          `${CONFIG_BASE}/sip_proxy/`,
          g,
          { name: args.name },
        );
        if (proxies.length === 0) {
          throw new Error(`SIP proxy '${args.name}' not found`);
        }
        await pexipApi(proxies[0].resource_uri as string, g, {
          method: "DELETE",
        });
        context.logger.info("Deleted SIP proxy '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-sip-proxy-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- SIP credentials ---

    listSipCredentials: {
      description: "List all SIP authentication credentials.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const creds = await pexipListAll(
          `${CONFIG_BASE}/sip_credential/`,
          g,
        );
        context.logger.info("Found {count} SIP credentials", {
          count: creds.length,
        });
        return {
          data: {
            attributes: { credentials: creds, count: creds.length },
            name: "sip-credentials",
          },
        };
      },
    },

    createSipCredential: {
      description:
        "Create a SIP authentication credential (realm + username + password).",
      arguments: z.object({
        realm: z.string().describe("SIP realm"),
        username: z.string().describe("SIP auth username"),
        password: z.string().meta({ sensitive: true }).describe(
          "SIP auth password",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/sip_credential/`, g, {
          method: "POST",
          body: {
            realm: args.realm,
            username: args.username,
            password: args.password,
          },
        });
        context.logger.info("Created SIP credential for realm '{realm}'", {
          realm: args.realm,
        });
        return {
          data: {
            attributes: { realm: args.realm, username: args.username },
            name: `sip-cred-${sanitizeId(args.realm)}`,
          },
        };
      },
    },

    // --- MSSIP proxies (Skype/Lync) ---

    listMssipProxies: {
      description:
        "List all MSSIP proxy configurations (Skype for Business / Lync).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const proxies = await pexipListAll(
          `${CONFIG_BASE}/mssip_proxy/`,
          g,
        );
        context.logger.info("Found {count} MSSIP proxies", {
          count: proxies.length,
        });
        return {
          data: {
            attributes: { proxies, count: proxies.length },
            name: "mssip-proxies",
          },
        };
      },
    },

    createMssipProxy: {
      description:
        "Create an MSSIP proxy (Skype for Business / Lync edge server).",
      arguments: z.object({
        name: z.string().describe("Proxy name"),
        address: z.string().describe("Edge server address"),
        transport: z.enum(["tcp", "tls"]).default("tls"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          transport: args.transport,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/mssip_proxy/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created MSSIP proxy '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `mssip-proxy-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Teams proxies ---

    listTeamsProxies: {
      description:
        "List all Teams proxy configurations (CVI media relay for Microsoft Teams).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const proxies = await pexipListAll(
          `${CONFIG_BASE}/teams_proxy/`,
          g,
        );
        context.logger.info("Found {count} Teams proxies", {
          count: proxies.length,
        });
        return {
          data: {
            attributes: { proxies, count: proxies.length },
            name: "teams-proxies",
          },
        };
      },
    },

    createTeamsProxy: {
      description: "Create a Teams proxy for CVI media relay.",
      arguments: z.object({
        name: z.string().describe("Proxy name"),
        address: z.string().describe("Proxy address"),
        azureTenant: z
          .string()
          .optional()
          .describe("Azure tenant resource URI"),
        notificationsEnabled: z
          .boolean()
          .default(false)
          .describe("Enable event hub notifications"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          notifications_enabled: args.notificationsEnabled,
        };
        if (args.description) body.description = args.description;
        if (args.azureTenant) body.azure_tenant = args.azureTenant;

        await pexipApi(`${CONFIG_BASE}/teams_proxy/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created Teams proxy '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `teams-proxy-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- H.323 gatekeepers ---

    listH323Gatekeepers: {
      description: "List all H.323 gatekeeper registrations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const gks = await pexipListAll(
          `${CONFIG_BASE}/h323_gatekeeper/`,
          g,
        );
        context.logger.info("Found {count} H.323 gatekeepers", {
          count: gks.length,
        });
        return {
          data: {
            attributes: { gatekeepers: gks, count: gks.length },
            name: "h323-gatekeepers",
          },
        };
      },
    },

    createH323Gatekeeper: {
      description: "Register with an H.323 gatekeeper.",
      arguments: z.object({
        name: z.string().describe("Gatekeeper name"),
        address: z.string().describe("Gatekeeper address"),
        port: z.number().default(1719).describe("RAS port"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          port: args.port,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/h323_gatekeeper/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created H.323 gatekeeper '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `h323-gk-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- STUN servers ---

    listStunServers: {
      description: "List all STUN server configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(
          `${CONFIG_BASE}/stun_server/`,
          g,
        );
        context.logger.info("Found {count} STUN servers", {
          count: servers.length,
        });
        return {
          data: {
            attributes: { servers, count: servers.length },
            name: "stun-servers",
          },
        };
      },
    },

    createStunServer: {
      description: "Add a STUN server for WebRTC NAT traversal.",
      arguments: z.object({
        name: z.string().describe("Server name"),
        address: z.string().describe("STUN server address"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/stun_server/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created STUN server '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `stun-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- SMTP ---

    listSmtpServers: {
      description: "List all SMTP server configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(
          `${CONFIG_BASE}/smtp_server/`,
          g,
        );
        context.logger.info("Found {count} SMTP servers", {
          count: servers.length,
        });
        return {
          data: {
            attributes: { servers, count: servers.length },
            name: "smtp-servers",
          },
        };
      },
    },

    createSmtpServer: {
      description: "Configure an SMTP server for email notifications.",
      arguments: z.object({
        name: z.string().describe("Server name"),
        address: z.string().describe("SMTP server address"),
        port: z.number().default(587).describe("SMTP port"),
        fromEmail: z.string().describe("From email address"),
        username: z.string().optional().describe("SMTP username"),
        password: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("SMTP password"),
        connectionSecurity: z
          .enum(["none", "starttls", "tls"])
          .default("starttls")
          .describe("Connection security mode"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          port: args.port,
          from_email_address: args.fromEmail,
          connection_security: args.connectionSecurity,
        };
        if (args.description) body.description = args.description;
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/smtp_server/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created SMTP server '{name}'", {
          name: args.name,
        });
        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `smtp-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Static routes ---

    listStaticRoutes: {
      description: "List all static network routes on the platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const routes = await pexipListAll(
          `${CONFIG_BASE}/static_route/`,
          g,
        );
        context.logger.info("Found {count} static routes", {
          count: routes.length,
        });
        return {
          data: {
            attributes: { routes, count: routes.length },
            name: "static-routes",
          },
        };
      },
    },

    createStaticRoute: {
      description: "Add a static network route.",
      arguments: z.object({
        name: z.string().describe("Route name"),
        address: z.string().describe("Destination network address"),
        prefix: z.number().describe("CIDR prefix length"),
        gateway: z.string().describe("Gateway address"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/static_route/`, g, {
          method: "POST",
          body: {
            name: args.name,
            address: args.address,
            prefix: args.prefix,
            gateway: args.gateway,
          },
        });
        context.logger.info(
          "Created static route '{name}' ({address}/{prefix} → {gateway})",
          {
            name: args.name,
            address: args.address,
            prefix: args.prefix,
            gateway: args.gateway,
          },
        );
        return {
          data: {
            attributes: {
              name: args.name,
              address: args.address,
              prefix: args.prefix,
              gateway: args.gateway,
            },
            name: `route-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full network inventory: SIP proxies, SIP credentials, MSSIP proxies, Teams proxies, H.323 gatekeepers, STUN servers, SMTP servers, and static routes.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [
          sipProxies,
          sipCreds,
          mssipProxies,
          teamsProxies,
          h323Gks,
          stunServers,
          smtpServers,
          staticRoutes,
        ] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/sip_proxy/`, g),
          pexipListAll(`${CONFIG_BASE}/sip_credential/`, g),
          pexipListAll(`${CONFIG_BASE}/mssip_proxy/`, g),
          pexipListAll(`${CONFIG_BASE}/teams_proxy/`, g),
          pexipListAll(`${CONFIG_BASE}/h323_gatekeeper/`, g),
          pexipListAll(`${CONFIG_BASE}/stun_server/`, g),
          pexipListAll(`${CONFIG_BASE}/smtp_server/`, g),
          pexipListAll(`${CONFIG_BASE}/static_route/`, g),
        ]);

        context.logger.info(
          "Network inventory: {sip} SIP, {mssip} MSSIP, {teams} Teams, {h323} H.323, {stun} STUN, {smtp} SMTP, {routes} routes",
          {
            sip: sipProxies.length,
            mssip: mssipProxies.length,
            teams: teamsProxies.length,
            h323: h323Gks.length,
            stun: stunServers.length,
            smtp: smtpServers.length,
            routes: staticRoutes.length,
          },
        );

        return {
          data: {
            attributes: {
              sipProxies,
              sipCredentials: sipCreds,
              mssipProxies,
              teamsProxies,
              h323Gatekeepers: h323Gks,
              stunServers,
              smtpServers,
              staticRoutes,
            },
            name: "network-inventory",
          },
        };
      },
    },
  },
};
