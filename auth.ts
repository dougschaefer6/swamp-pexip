import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity authentication, RBAC, OAuth2 client management, and end
 * user directory.
 *
 * Covers:
 *   - Platform authentication settings (OIDC, LDAP, client certificates)
 *   - OAuth2 API client management
 *   - Role definitions and role mappings
 *   - End user directory (personal VMRs, LDAP-synced users)
 *   - Break-in allowlists for security
 *
 * Docs: https://docs.pexip.com/admin/auth_overview.htm
 */

/**
 * `@dougschaefer/pexip-auth` model — authentication, RBAC, and access
 * control on Pexip Infinity via the v39 management API.
 * getAuthConfig and updateAuthConfig drive the platform-wide
 * AuthenticationConfig (OIDC, SAML, LDAP, local password policy, MFA).
 * Role and role-mapping CRUD wires identity-provider groups to
 * internal roles for admin and end-user access. End-user CRUD
 * manages the local Infinity user directory used for client login
 * and meeting hosting. Allowlist methods control administrator-
 * source IP restrictions for the management web interface.
 * inventory aggregates the auth posture in one read for compliance
 * and drift checks. Mutations apply to the live management node
 * and take effect on operator login immediately.
 */
export const model = {
  type: "@dougschaefer/pexip-auth",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Authentication settings ---

    getAuthConfig: {
      description:
        "Get the platform authentication configuration (OIDC, LDAP, certificate settings).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const config = await pexipListAll(
          `${CONFIG_BASE}/authentication/`,
          g,
        );

        return {
          data: {
            attributes: config[0] || {},
            name: "auth-config",
          },
        };
      },
    },

    updateAuthConfig: {
      description:
        "Update platform authentication settings (OIDC provider, LDAP server, certificate auth).",
      arguments: z.object({
        source: z
          .enum(["local", "ldap", "oidc"])
          .optional()
          .describe("Authentication source"),
        clientCertificate: z
          .boolean()
          .optional()
          .describe("Enable client certificate authentication"),
        apiOauth2DisableBasic: z
          .boolean()
          .optional()
          .describe("Disable HTTP Basic auth on the API (require OAuth2)"),
        oidcMetadataUrl: z
          .string()
          .optional()
          .describe("OIDC discovery endpoint URL"),
        oidcClientId: z
          .string()
          .optional()
          .describe("OIDC client ID"),
        oidcClientSecret: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("OIDC client secret"),
        oidcScope: z
          .string()
          .optional()
          .describe("OIDC scope (default: openid profile email)"),
        ldapServer: z
          .string()
          .optional()
          .describe("LDAP server address"),
        ldapBaseDn: z
          .string()
          .optional()
          .describe("LDAP base DN for searches"),
        ldapBindUsername: z
          .string()
          .optional()
          .describe("LDAP bind username"),
        ldapBindPassword: z
          .string()
          .optional()
          .meta({ sensitive: true })
          .describe("LDAP bind password"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const configs = await pexipListAll(
          `${CONFIG_BASE}/authentication/`,
          g,
        );
        if (configs.length === 0) {
          throw new Error("No authentication configuration found");
        }

        const uri = configs[0].resource_uri as string;
        const body: Record<string, unknown> = {};
        if (args.source !== undefined) body.source = args.source;
        if (args.clientCertificate !== undefined) {
          body.client_certificate = args.clientCertificate;
        }
        if (args.apiOauth2DisableBasic !== undefined) {
          body.api_oauth2_disable_basic = args.apiOauth2DisableBasic;
        }
        if (args.oidcMetadataUrl !== undefined) {
          body.oidc_metadata_url = args.oidcMetadataUrl;
        }
        if (args.oidcClientId !== undefined) {
          body.oidc_client_id = args.oidcClientId;
        }
        if (args.oidcClientSecret !== undefined) {
          body.oidc_client_secret = args.oidcClientSecret;
        }
        if (args.oidcScope !== undefined) body.oidc_scope = args.oidcScope;
        if (args.ldapServer !== undefined) body.ldap_server = args.ldapServer;
        if (args.ldapBaseDn !== undefined) body.ldap_base_dn = args.ldapBaseDn;
        if (args.ldapBindUsername !== undefined) {
          body.ldap_bind_username = args.ldapBindUsername;
        }
        if (args.ldapBindPassword !== undefined) {
          body.ldap_bind_password = args.ldapBindPassword;
        }

        await pexipApi(uri, g, { method: "PATCH", body });

        context.logger.info("Updated authentication config");

        return {
          data: {
            attributes: { updated: Object.keys(body) },
            name: "auth-config",
          },
        };
      },
    },

    // --- OAuth2 clients ---

    listOAuth2Clients: {
      description: "List all OAuth2 API clients registered on the platform.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const clients = await pexipListAll(
          `${CONFIG_BASE}/oauth2_client/`,
          g,
        );

        context.logger.info("Found {count} OAuth2 clients", {
          count: clients.length,
        });

        return {
          data: {
            attributes: { clients, count: clients.length },
            name: "oauth2-clients",
          },
        };
      },
    },

    createOAuth2Client: {
      description:
        "Create an OAuth2 API client for machine-to-machine API access.",
      arguments: z.object({
        clientName: z.string().describe("Display name for the API client"),
        role: z.string().describe(
          "Role to assign (determines API permissions)",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        const result = await pexipApi(`${CONFIG_BASE}/oauth2_client/`, g, {
          method: "POST",
          body: { client_name: args.clientName, role: args.role },
        });

        context.logger.info("Created OAuth2 client '{name}'", {
          name: args.clientName,
        });

        return {
          data: {
            attributes: result as Record<string, unknown>,
            name: `oauth2-${sanitizeId(args.clientName)}`,
          },
        };
      },
    },

    deleteOAuth2Client: {
      description: "Delete an OAuth2 API client.",
      arguments: z.object({
        clientName: z.string().describe("Client name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const clients = await pexipListAll(
          `${CONFIG_BASE}/oauth2_client/`,
          g,
          { client_name: args.clientName },
        );

        if (clients.length === 0) {
          throw new Error(`OAuth2 client '${args.clientName}' not found`);
        }

        const uri = clients[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted OAuth2 client '{name}'", {
          name: args.clientName,
        });

        return {
          data: {
            attributes: { deleted: args.clientName },
            name: `deleted-oauth2-${sanitizeId(args.clientName)}`,
          },
        };
      },
    },

    // --- Roles ---

    listRoles: {
      description: "List all platform roles with their permissions.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const roles = await pexipListAll(`${CONFIG_BASE}/role/`, g);

        context.logger.info("Found {count} roles", { count: roles.length });

        return {
          data: {
            attributes: { roles, count: roles.length },
            name: "roles",
          },
        };
      },
    },

    createRole: {
      description: "Create a custom role with specific permissions.",
      arguments: z.object({
        name: z.string().describe("Role name"),
        permissions: z
          .array(z.string())
          .describe("Permission strings to assign"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        await pexipApi(`${CONFIG_BASE}/role/`, g, {
          method: "POST",
          body: { name: args.name, permissions: args.permissions },
        });

        context.logger.info("Created role '{name}' with {count} permissions", {
          name: args.name,
          count: args.permissions.length,
        });

        return {
          data: {
            attributes: {
              name: args.name,
              permissions: args.permissions,
            },
            name: `role-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deleteRole: {
      description: "Delete a custom role.",
      arguments: z.object({
        name: z.string().describe("Role name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const roles = await pexipListAll(`${CONFIG_BASE}/role/`, g, {
          name: args.name,
        });

        if (roles.length === 0) {
          throw new Error(`Role '${args.name}' not found`);
        }

        const uri = roles[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted role '{name}'", { name: args.name });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-role-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Role mappings ---

    listRoleMappings: {
      description:
        "List all role mappings (map OIDC/LDAP attributes to platform roles).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const mappings = await pexipListAll(
          `${CONFIG_BASE}/role_mapping/`,
          g,
        );

        context.logger.info("Found {count} role mappings", {
          count: mappings.length,
        });

        return {
          data: {
            attributes: { mappings, count: mappings.length },
            name: "role-mappings",
          },
        };
      },
    },

    createRoleMapping: {
      description:
        "Create a role mapping that assigns roles based on OIDC/LDAP attributes.",
      arguments: z.object({
        name: z.string().describe("Mapping name"),
        source: z
          .enum(["oidc", "ldap"])
          .describe("Attribute source"),
        value: z
          .string()
          .describe("Attribute value to match"),
        roles: z
          .array(z.string())
          .describe("Role names to assign when matched"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        await pexipApi(`${CONFIG_BASE}/role_mapping/`, g, {
          method: "POST",
          body: {
            name: args.name,
            source: args.source,
            value: args.value,
            roles: args.roles,
          },
        });

        context.logger.info("Created role mapping '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: {
              name: args.name,
              source: args.source,
              value: args.value,
              roles: args.roles,
            },
            name: `mapping-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- End users ---

    listEndUsers: {
      description:
        "List all end users in the directory (personal VMR owners, LDAP-synced users).",
      arguments: z.object({
        email: z
          .string()
          .optional()
          .describe("Filter by email address"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.email) params.primary_email_address = args.email;

        const users = await pexipListAll(
          `${CONFIG_BASE}/end_user/`,
          g,
          params,
        );

        context.logger.info("Found {count} end users", {
          count: users.length,
        });

        return {
          data: {
            attributes: { users, count: users.length },
            name: "end-users",
          },
        };
      },
    },

    createEndUser: {
      description: "Create an end user in the directory.",
      arguments: z.object({
        email: z.string().describe("Primary email address"),
        firstName: z.string().optional().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        displayName: z.string().optional().describe("Display name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          primary_email_address: args.email,
        };
        if (args.firstName) body.first_name = args.firstName;
        if (args.lastName) body.last_name = args.lastName;
        if (args.displayName) body.display_name = args.displayName;

        await pexipApi(`${CONFIG_BASE}/end_user/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created end user '{email}'", {
          email: args.email,
        });

        return {
          data: {
            attributes: { email: args.email },
            name: `user-${sanitizeId(args.email)}`,
          },
        };
      },
    },

    // --- Break-in allowlist ---

    listAllowlist: {
      description:
        "List all break-in allowlist entries (trusted addresses that bypass security checks).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const entries = await pexipListAll(
          `${CONFIG_BASE}/break_in_allow_list_address/`,
          g,
        );

        context.logger.info("Found {count} allowlist entries", {
          count: entries.length,
        });

        return {
          data: {
            attributes: { entries, count: entries.length },
            name: "allowlist",
          },
        };
      },
    },

    createAllowlistEntry: {
      description:
        "Add an address to the break-in allowlist (trusted source that bypasses incorrect PIN/alias lockouts).",
      arguments: z.object({
        name: z.string().describe("Entry name"),
        address: z.string().describe("IP address or hostname"),
        prefix: z
          .number()
          .optional()
          .describe("CIDR prefix length (e.g., 24 for /24)"),
        ignoreIncorrectAliases: z
          .boolean()
          .default(false)
          .describe("Skip alias validation checks from this source"),
        ignoreIncorrectPins: z
          .boolean()
          .default(false)
          .describe("Skip PIN brute-force lockout from this source"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          name: args.name,
          address: args.address,
          ignore_incorrect_aliases: args.ignoreIncorrectAliases,
          ignore_incorrect_pins: args.ignoreIncorrectPins,
        };
        if (args.prefix !== undefined) body.prefix = args.prefix;

        await pexipApi(
          `${CONFIG_BASE}/break_in_allow_list_address/`,
          g,
          { method: "POST", body },
        );

        context.logger.info("Added allowlist entry '{name}' ({address})", {
          name: args.name,
          address: args.address,
        });

        return {
          data: {
            attributes: { name: args.name, address: args.address },
            name: `allowlist-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full auth inventory: authentication config, OAuth2 clients, roles, role mappings, end users, and allowlist.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [authConfig, oauth2, roles, mappings, users, allowlist] =
          await Promise.all([
            pexipListAll(`${CONFIG_BASE}/authentication/`, g),
            pexipListAll(`${CONFIG_BASE}/oauth2_client/`, g),
            pexipListAll(`${CONFIG_BASE}/role/`, g),
            pexipListAll(`${CONFIG_BASE}/role_mapping/`, g),
            pexipListAll(`${CONFIG_BASE}/end_user/`, g),
            pexipListAll(
              `${CONFIG_BASE}/break_in_allow_list_address/`,
              g,
            ),
          ]);

        context.logger.info(
          "Auth inventory: {oauth2} clients, {roles} roles, {mappings} mappings, {users} users, {allowlist} allowlist",
          {
            oauth2: oauth2.length,
            roles: roles.length,
            mappings: mappings.length,
            users: users.length,
            allowlist: allowlist.length,
          },
        );

        return {
          data: {
            attributes: {
              authConfig: authConfig[0] || {},
              oauth2Clients: oauth2,
              roles,
              roleMappings: mappings,
              endUsers: users,
              allowlist,
            },
            name: "auth-inventory",
          },
        };
      },
    },
  },
};
