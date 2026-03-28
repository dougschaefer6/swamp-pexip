import { z } from "npm:zod@4";
import {
  CONFIG_BASE,
  extractId,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

// --- Resource schemas ---

const EventSinkSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    url: z.string(),
    description: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    verify_tls: z.boolean().optional(),
    event_api_version: z.number().optional(),
    use_bulk_mode: z.boolean().optional(),
    system_locations: z.array(z.string()).optional(),
  })
  .passthrough();

const TlsCertificateSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    certificate: z.string().optional(),
    intermediate_certificates: z.string().optional(),
    is_default: z.boolean().optional(),
    expiry: z.string().optional(),
    subject: z.string().optional(),
    issuer: z.string().optional(),
  })
  .passthrough();

const TeamsConnectorSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    teams_domain: z.string().optional(),
    azure_tenant_id: z.string().optional(),
    azure_client_id: z.string().optional(),
  })
  .passthrough();

const SipRegistrationSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    sip_proxy: z.string().optional(),
    username: z.string().optional(),
    transport: z.string().optional(),
    port: z.number().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const LdapSourceSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    server_address: z.string().optional(),
    base_dn: z.string().optional(),
    bind_dn: z.string().optional(),
    use_tls: z.boolean().optional(),
    port: z.number().optional(),
    sync_interval: z.number().optional(),
  })
  .passthrough();

const _SnmpSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    community_string: z.string().optional(),
    allowed_subnets: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const _SyslogSchema = z
  .object({
    id: z.number().optional(),
    resource_uri: z.string().optional(),
    server_address: z.string().optional(),
    port: z.number().optional(),
    protocol: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const model = {
  type: "@dougschaefer/pexip-integration",
  version: "2026.03.26.1",
  globalArguments: PexipGlobalArgsSchema,
  resources: {
    eventSink: {
      description:
        "Event sink for pushing conference events to external services",
      schema: EventSinkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    tlsCertificate: {
      description: "TLS certificate for platform services",
      schema: TlsCertificateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    teamsConnector: {
      description: "Microsoft Teams connector configuration",
      schema: TeamsConnectorSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    sipRegistration: {
      description: "SIP registration (trunk to external SBC/proxy)",
      schema: SipRegistrationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    ldapSource: {
      description: "LDAP/AD directory source for contact sync",
      schema: LdapSourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    // --- Event sinks ---

    listEventSinks: {
      description: "List all configured event sinks.",
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

        const handles = [];
        for (const sink of sinks) {
          const handle = await context.writeResource(
            "eventSink",
            sanitizeId(sink.name as string),
            sink,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createEventSink: {
      description:
        "Create an event sink to push conference/participant events to an external HTTP(S) endpoint.",
      arguments: z.object({
        name: z.string().describe("Event sink name"),
        url: z.string().url().describe("External server URL (HTTP/HTTPS)"),
        username: z
          .string()
          .optional()
          .describe("Username for HTTP basic auth"),
        password: z
          .string()
          .optional()
          .describe("Password for HTTP basic auth"),
        verifyTls: z.boolean().optional().default(true).describe("Verify TLS"),
        apiVersion: z
          .number()
          .optional()
          .default(2)
          .describe("Event API version (1 or 2)"),
        bulkMode: z
          .boolean()
          .optional()
          .default(true)
          .describe("Batch events for efficiency"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          url: args.url,
          verify_tls: args.verifyTls,
          event_api_version: args.apiVersion,
          use_bulk_mode: args.bulkMode,
        };
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/event_sink/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created event sink {name} → {url}", {
          name: args.name,
          url: args.url,
        });

        return { dataHandles: [] };
      },
    },

    deleteEventSink: {
      description: "Delete an event sink.",
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
        const sink = sinks.find((s) => s.name === args.name);
        if (!sink) throw new Error(`Event sink not found: ${args.name}`);

        const sinkId = extractId(sink.resource_uri as string);
        await pexipApi(`${CONFIG_BASE}/event_sink/${sinkId}/`, g, {
          method: "DELETE",
        });

        context.logger.info("Deleted event sink {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- TLS certificates ---

    listCertificates: {
      description: "List all TLS certificates on the platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const certs = await pexipListAll(
          `${CONFIG_BASE}/tls_certificate/`,
          g,
        );

        context.logger.info("Found {count} TLS certificates", {
          count: certs.length,
        });

        const handles = [];
        for (const cert of certs) {
          const handle = await context.writeResource(
            "tlsCertificate",
            sanitizeId(cert.name as string),
            cert,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    uploadCertificate: {
      description:
        "Upload a TLS certificate (PEM format). Provide cert + key + optional intermediate chain.",
      arguments: z.object({
        name: z.string().describe("Certificate name"),
        certificate: z.string().describe("PEM-encoded certificate"),
        privateKey: z.string().describe("PEM-encoded private key"),
        intermediateCertificates: z
          .string()
          .optional()
          .describe("PEM-encoded intermediate certificate chain"),
        isDefault: z
          .boolean()
          .optional()
          .default(false)
          .describe("Set as default certificate"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          certificate: args.certificate,
          private_key: args.privateKey,
          is_default: args.isDefault,
        };
        if (args.intermediateCertificates) {
          body.intermediate_certificates = args.intermediateCertificates;
        }

        await pexipApi(`${CONFIG_BASE}/tls_certificate/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Uploaded TLS certificate {name}", {
          name: args.name,
        });

        return { dataHandles: [] };
      },
    },

    // --- SIP registrations ---

    listSipRegistrations: {
      description: "List all SIP registrations (trunks to external SBC/proxy).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const regs = await pexipListAll(
          `${CONFIG_BASE}/registration/`,
          g,
        );

        context.logger.info("Found {count} SIP registrations", {
          count: regs.length,
        });

        const handles = [];
        for (const reg of regs) {
          const handle = await context.writeResource(
            "sipRegistration",
            sanitizeId(reg.name as string),
            reg,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createSipRegistration: {
      description: "Create a SIP registration (trunk to external SBC/proxy).",
      arguments: z.object({
        name: z.string().describe("Registration name"),
        sipProxy: z.string().describe("SIP proxy address"),
        username: z.string().describe("SIP username/alias to register"),
        password: z
          .string()
          .optional()
          .describe("SIP authentication password"),
        transport: z
          .enum(["tcp", "tls", "udp"])
          .optional()
          .default("tls")
          .describe("SIP transport protocol"),
        port: z.number().optional().default(5061).describe("SIP proxy port"),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          sip_proxy: args.sipProxy,
          username: args.username,
          transport: args.transport,
          port: args.port,
          enabled: args.enabled,
        };
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/registration/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created SIP registration {name} → {proxy}", {
          name: args.name,
          proxy: args.sipProxy,
        });

        return { dataHandles: [] };
      },
    },

    // --- LDAP sources ---

    listLdapSources: {
      description: "List all LDAP/AD directory sources.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const sources = await pexipListAll(
          `${CONFIG_BASE}/ldap_source/`,
          g,
        );

        context.logger.info("Found {count} LDAP sources", {
          count: sources.length,
        });

        const handles = [];
        for (const source of sources) {
          const handle = await context.writeResource(
            "ldapSource",
            sanitizeId(source.name as string),
            source,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- Teams connector ---

    listTeamsConnectors: {
      description: "List Microsoft Teams connector configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const connectors = await pexipListAll(
          `${CONFIG_BASE}/teams_connector/`,
          g,
        );

        context.logger.info("Found {count} Teams connectors", {
          count: connectors.length,
        });

        const handles = [];
        for (const conn of connectors) {
          const handle = await context.writeResource(
            "teamsConnector",
            sanitizeId(conn.name as string),
            conn,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- LDAP sync trigger ---

    syncLdap: {
      description:
        "Trigger an immediate LDAP directory sync (normally runs daily at 01:00 UTC).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        await pexipApi(
          "/api/admin/command/v1/conference/sync/",
          g,
          { method: "POST", body: {} },
        );

        context.logger.info("LDAP sync triggered");
        return { dataHandles: [] };
      },
    },

    // --- Identity providers / SSO ---

    listIdentityProviders: {
      description:
        "List configured identity providers (SAML/OIDC) for conference participant SSO.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const idps = await pexipListAll(`${CONFIG_BASE}/identity_provider/`, g);
        context.logger.info("Found {count} identity providers", {
          count: idps.length,
        });
        return { dataHandles: [] };
      },
    },

    createIdentityProvider: {
      description:
        "Configure an identity provider for conference participant authentication.",
      arguments: z.object({
        name: z.string().describe("IdP name"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/identity_provider/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created identity provider {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    deleteIdentityProvider: {
      description: "Remove an identity provider configuration.",
      arguments: z.object({ name: z.string() }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const idps = await pexipListAll(
          `${CONFIG_BASE}/identity_provider/`,
          g,
          { name: args.name },
        );
        const idp = idps.find((i) => i.name === args.name);
        if (!idp) throw new Error(`Identity provider not found: ${args.name}`);
        const idpId = extractId(idp.resource_uri as string);
        await pexipApi(`${CONFIG_BASE}/identity_provider/${idpId}/`, g, {
          method: "DELETE",
        });
        context.logger.info("Deleted identity provider {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    listIdentityProviderGroups: {
      description:
        "List identity provider groups (control which IdP users can access which services).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const groups = await pexipListAll(
          `${CONFIG_BASE}/identity_provider_group/`,
          g,
        );
        context.logger.info("Found {count} IdP groups", {
          count: groups.length,
        });
        return { dataHandles: [] };
      },
    },

    // --- User groups ---

    listUserGroups: {
      description: "List user groups for access control.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const groups = await pexipListAll(`${CONFIG_BASE}/user_group/`, g);
        context.logger.info("Found {count} user groups", {
          count: groups.length,
        });
        return { dataHandles: [] };
      },
    },

    // --- Media library / playback service ---

    listMediaLibrary: {
      description:
        "List media library entries (prerecorded video/audio for hold music, IVR, playback service).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const entries = await pexipListAll(
          `${CONFIG_BASE}/media_library_entry/`,
          g,
        );
        context.logger.info("Found {count} media library entries", {
          count: entries.length,
        });
        return { dataHandles: [] };
      },
    },

    listPlaylists: {
      description: "List media playlists.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const playlists = await pexipListAll(
          `${CONFIG_BASE}/media_library_playlist/`,
          g,
        );
        context.logger.info("Found {count} playlists", {
          count: playlists.length,
        });
        return { dataHandles: [] };
      },
    },

    createPlaylist: {
      description: "Create a media playlist for the playback service or IVR.",
      arguments: z.object({
        name: z.string().describe("Playlist name"),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/media_library_playlist/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created playlist {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- Web app branding ---

    listBrandingPackages: {
      description:
        "List web app branding packages (per-client branded meeting experiences).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const packages = await pexipListAll(
          `${CONFIG_BASE}/webapp_branding/`,
          g,
        );
        context.logger.info("Found {count} branding packages", {
          count: packages.length,
        });
        return { dataHandles: [] };
      },
    },

    listWebAppPaths: {
      description:
        "List web app path aliases (custom URLs for branded experiences).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const paths = await pexipListAll(`${CONFIG_BASE}/webapp_alias/`, g);
        context.logger.info("Found {count} web app paths", {
          count: paths.length,
        });
        return { dataHandles: [] };
      },
    },

    createWebAppPath: {
      description: "Create a web app path alias (e.g., /meet/clientname).",
      arguments: z.object({
        path: z.string().describe("URL path (e.g., /meet/clientname)"),
        brandingUri: z.string().optional().describe(
          "Resource URI of branding package",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { path: args.path };
        if (args.brandingUri) body.branding = args.brandingUri;

        await pexipApi(`${CONFIG_BASE}/webapp_alias/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created web app path {path}", { path: args.path });
        return { dataHandles: [] };
      },
    },

    // --- CSR generation ---

    listCsrs: {
      description: "List certificate signing requests.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const csrs = await pexipListAll(
          `${CONFIG_BASE}/certificate_signing_request/`,
          g,
        );
        context.logger.info("Found {count} CSRs", { count: csrs.length });
        return { dataHandles: [] };
      },
    },

    createCsr: {
      description:
        "Generate a certificate signing request on the management node (keeps private key on-box).",
      arguments: z.object({
        name: z.string().describe("CSR name"),
        commonName: z.string().describe(
          "Common name (FQDN) for the certificate",
        ),
        subjectAlternativeNames: z
          .array(z.string())
          .optional()
          .describe("SANs (additional FQDNs or IPs)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          common_name: args.commonName,
        };
        if (args.subjectAlternativeNames) {
          body.subject_alternative_names = args.subjectAlternativeNames.join(
            ",",
          );
        }

        await pexipApi(`${CONFIG_BASE}/certificate_signing_request/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Generated CSR {name} for {cn}", {
          name: args.name,
          cn: args.commonName,
        });
        return { dataHandles: [] };
      },
    },

    // --- Azure tenant (Teams CVI) ---

    listAzureTenants: {
      description:
        "List Microsoft Azure/Entra tenant configurations for Teams CVI.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const tenants = await pexipListAll(
          `${CONFIG_BASE}/azure_tenant/`,
          g,
        );
        context.logger.info("Found {count} Azure tenants", {
          count: tenants.length,
        });
        const handles = [];
        for (const t of tenants) {
          handles.push(
            await context.writeResource(
              "teamsConnector",
              sanitizeId(t.name as string),
              t,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    createAzureTenant: {
      description:
        "Configure a Microsoft Azure/Entra tenant for Teams CVI integration.",
      arguments: z.object({
        name: z.string().describe("Tenant configuration name"),
        tenantId: z.string().describe(
          "Azure AD / Entra tenant ID (Directory ID)",
        ),
        description: z.string().optional(),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          teams_tenant_id: args.tenantId,
        };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/azure_tenant/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created Azure tenant config {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    // --- TURN / STUN servers ---

    listTurnServers: {
      description: "List TURN server configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(`${CONFIG_BASE}/turn_server/`, g);
        context.logger.info("Found {count} TURN servers", {
          count: servers.length,
        });
        return { dataHandles: [] };
      },
    },

    createTurnServer: {
      description: "Configure a TURN server for NAT traversal.",
      arguments: z.object({
        name: z.string().describe("TURN server name"),
        address: z.string().describe("TURN server address"),
        port: z.number().optional().default(3478),
        username: z.string().optional(),
        password: z.string().optional(),
        protocol: z.enum(["udp", "tcp", "tls"]).optional().default("udp"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          port: args.port,
          protocol: args.protocol,
        };
        if (args.username) body.username = args.username;
        if (args.password) body.password = args.password;

        await pexipApi(`${CONFIG_BASE}/turn_server/`, g, {
          method: "POST",
          body,
        });
        context.logger.info("Created TURN server {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    // --- Device registration ---

    listRegisteredDevices: {
      description: "List all registered device aliases.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const devices = await pexipListAll(`${CONFIG_BASE}/device/`, g);
        context.logger.info("Found {count} registered devices", {
          count: devices.length,
        });
        return { dataHandles: [] };
      },
    },

    // --- IVR themes ---

    listIvrThemes: {
      description: "List all IVR themes (branding, hold music, prompts).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const themes = await pexipListAll(`${CONFIG_BASE}/ivr_theme/`, g);
        context.logger.info("Found {count} IVR themes", {
          count: themes.length,
        });
        return { dataHandles: [] };
      },
    },

    // --- CA certificates ---

    listCaCertificates: {
      description: "List trusted CA certificates.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const certs = await pexipListAll(`${CONFIG_BASE}/ca_certificate/`, g);
        context.logger.info("Found {count} CA certificates", {
          count: certs.length,
        });
        return { dataHandles: [] };
      },
    },

    uploadCaCertificate: {
      description: "Upload a trusted CA certificate (PEM format).",
      arguments: z.object({
        name: z.string().describe("CA certificate name"),
        certificate: z.string().describe("PEM-encoded CA certificate"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/ca_certificate/`, g, {
          method: "POST",
          body: { name: args.name, certificate: args.certificate },
        });
        context.logger.info("Uploaded CA certificate {name}", {
          name: args.name,
        });
        return { dataHandles: [] };
      },
    },

    // --- External policy server ---

    listPolicyServers: {
      description: "List external policy server configurations.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const servers = await pexipListAll(`${CONFIG_BASE}/policy_server/`, g);
        context.logger.info("Found {count} policy servers", {
          count: servers.length,
        });
        return { dataHandles: [] };
      },
    },

    createPolicyServer: {
      description:
        "Configure an external policy server for dynamic call routing decisions.",
      arguments: z.object({
        name: z.string().describe("Policy server name"),
        url: z.string().url().describe("Policy server URL (HTTPS recommended)"),
        username: z.string().optional().describe("HTTP basic auth username"),
        password: z.string().optional().describe("HTTP basic auth password"),
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
        context.logger.info("Created policy server {name} → {url}", {
          name: args.name,
          url: args.url,
        });
        return { dataHandles: [] };
      },
    },

    // --- Auto-backup configuration ---

    configureAutoBackup: {
      description: "Configure automatic scheduled backups.",
      arguments: z.object({
        enabled: z.boolean().describe("Enable automatic backups"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        await pexipApi(`${CONFIG_BASE}/autobackup/`, g, {
          method: "PATCH",
          body: { enabled: args.enabled },
        });
        context.logger.info("{action} auto-backup", {
          action: args.enabled ? "Enabled" : "Disabled",
        });
        return { dataHandles: [] };
      },
    },

    // --- SNMP configuration ---

    configureSnmp: {
      description: "Configure SNMP monitoring on the platform.",
      arguments: z.object({
        communityString: z
          .string()
          .optional()
          .default("public")
          .describe("SNMP community string"),
        allowedSubnets: z
          .array(z.string())
          .optional()
          .describe("Subnets allowed to poll SNMP (CIDR format)"),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          community_string: args.communityString,
          enabled: args.enabled,
        };
        if (args.allowedSubnets) {
          body.allowed_subnets = args.allowedSubnets;
        }

        await pexipApi(`${CONFIG_BASE}/snmp/`, g, {
          method: "PATCH",
          body,
        });

        context.logger.info("Updated SNMP configuration");
        return { dataHandles: [] };
      },
    },

    // --- Syslog configuration ---

    configureSyslog: {
      description: "Configure remote syslog forwarding.",
      arguments: z.object({
        serverAddress: z.string().describe("Syslog server address"),
        port: z.number().optional().default(514).describe("Syslog port"),
        protocol: z
          .enum(["udp", "tcp", "tls"])
          .optional()
          .default("udp")
          .describe("Syslog transport protocol"),
        enabled: z.boolean().optional().default(true),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          server_address: args.serverAddress,
          port: args.port,
          protocol: args.protocol,
          enabled: args.enabled,
        };

        await pexipApi(`${CONFIG_BASE}/syslog_server/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Configured syslog → {server}:{port}", {
          server: args.serverAddress,
          port: args.port,
        });

        return { dataHandles: [] };
      },
    },
  },
};
