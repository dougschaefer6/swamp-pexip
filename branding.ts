import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  sanitizeId,
} from "./_client.ts";

/**
 * Pexip Infinity branding, theming, webapp paths, IVR themes, and plugin
 * deployment.
 *
 * Branding packages are ZIP archives uploaded to the management node that
 * customize the Webapp3 meeting experience. A package contains:
 *   - manifest.json — app settings, color palette, translations, hidden UI,
 *     custom join steps, and plugin declarations
 *   - Static assets — logos, backgrounds, favicons
 *   - Plugin bundles — JavaScript files that extend the meeting UI via the
 *     @pexip/plugin-api
 *
 * Webapp paths map URL paths to branding packages, enabling custom branded
 * join experiences at different URL paths (e.g., /meet/sales, /meet/support).
 *
 * IVR themes control the audio/video experience for SIP/H.323 callers:
 *   hold music, PIN entry prompts, welcome screens.
 *
 * Branding portal (no-code): https://branding.pexip.io/
 * Advanced customization: https://docs.pexip.com/admin/customize_webapp_advanced.htm
 * Plugin API: https://developer.pexip.com/docs/infinity/web/plugins/webapp-3/plugin-api/introduction
 * Plugin template: https://github.com/pexip/plugin-template
 */

/**
 * `@dougschaefer/pexip-branding` model — webapp branding, theming, IVR
 * media, and on-hold music on Pexip Infinity via the v39 management
 * API. Package methods (list/get/delete) manage Web App 3 branding
 * bundles that ship custom CSS, logos, and plugin code to the
 * conferencing client. WebAppPath CRUD wires URL prefixes to specific
 * branding packages so different VMRs or aliases land on different
 * skinned web apps. listIvrThemes enumerates the audio/video assets
 * Pexip plays during PIN entry, music-on-hold, and waiting screens.
 * Media and playlist methods cover the asset library and the curated
 * playlists referenced by VMRs and the IVR engine. inventory rolls
 * the branding posture into one read for audit and rollout planning.
 * Mutations replace assets on the live management node and are
 * pushed to conferencing nodes on the next configuration sync.
 */
export const model = {
  type: "@dougschaefer/pexip-branding",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    // --- Branding packages ---

    listPackages: {
      description:
        "List all branding packages uploaded to the management node.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const packages = await pexipListAll(
          `${CONFIG_BASE}/webapp_branding_package/`,
          g,
        );

        context.logger.info("Found {count} branding packages", {
          count: packages.length,
        });

        return {
          data: {
            attributes: { packages, count: packages.length },
            name: "branding-packages",
          },
        };
      },
    },

    getPackage: {
      description: "Get details of a specific branding package by name.",
      arguments: z.object({
        name: z.string().describe("Branding package name"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const packages = await pexipListAll(
          `${CONFIG_BASE}/webapp_branding_package/`,
          g,
          { name: args.name },
        );

        if (packages.length === 0) {
          throw new Error(`Branding package '${args.name}' not found`);
        }

        return {
          data: {
            attributes: packages[0],
            name: `package-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    deletePackage: {
      description: "Delete a branding package from the management node.",
      arguments: z.object({
        name: z.string().describe("Branding package name to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const packages = await pexipListAll(
          `${CONFIG_BASE}/webapp_branding_package/`,
          g,
          { name: args.name },
        );

        if (packages.length === 0) {
          throw new Error(`Branding package '${args.name}' not found`);
        }

        const uri = packages[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted branding package '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { deleted: args.name },
            name: `deleted-package-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Webapp paths ---

    listWebAppPaths: {
      description:
        "List all webapp path aliases. Each path maps a URL to a branding package for custom join experiences.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const paths = await pexipListAll(
          `${CONFIG_BASE}/webapp_path/`,
          g,
        );

        context.logger.info("Found {count} webapp paths", {
          count: paths.length,
        });

        return {
          data: {
            attributes: { paths, count: paths.length },
            name: "webapp-paths",
          },
        };
      },
    },

    createWebAppPath: {
      description:
        "Create a webapp path alias that maps a URL path to a branding package (e.g., /meet/clientname).",
      arguments: z.object({
        path: z
          .string()
          .describe(
            "URL path segment (e.g., 'clientname' creates /webapp3/clientname/)",
          ),
        brandingPackage: z
          .string()
          .optional()
          .describe("Name of branding package to apply to this path"),
        allowIdpAuthentication: z
          .boolean()
          .optional()
          .describe("Allow identity provider authentication on this path"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = {
          path: args.path,
        };

        if (args.brandingPackage) {
          const packages = await pexipListAll(
            `${CONFIG_BASE}/webapp_branding_package/`,
            g,
            { name: args.brandingPackage },
          );
          if (packages.length > 0) {
            body.branding_package = packages[0].resource_uri;
          }
        }

        if (args.allowIdpAuthentication !== undefined) {
          body.allow_idp_authentication = args.allowIdpAuthentication;
        }

        await pexipApi(`${CONFIG_BASE}/webapp_path/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created webapp path '/{path}'", {
          path: args.path,
        });

        return {
          data: {
            attributes: {
              path: args.path,
              brandingPackage: args.brandingPackage || null,
            },
            name: `path-${sanitizeId(args.path)}`,
          },
        };
      },
    },

    deleteWebAppPath: {
      description: "Delete a webapp path alias.",
      arguments: z.object({
        path: z.string().describe("Webapp path to delete"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const paths = await pexipListAll(
          `${CONFIG_BASE}/webapp_path/`,
          g,
          { path: args.path },
        );

        if (paths.length === 0) {
          throw new Error(`Webapp path '${args.path}' not found`);
        }

        const uri = paths[0].resource_uri as string;
        await pexipApi(uri, g, { method: "DELETE" });

        context.logger.info("Deleted webapp path '/{path}'", {
          path: args.path,
        });

        return {
          data: {
            attributes: { deleted: args.path },
            name: `deleted-path-${sanitizeId(args.path)}`,
          },
        };
      },
    },

    // --- IVR themes ---

    listIvrThemes: {
      description:
        "List all IVR themes. Themes control hold music, PIN entry prompts, and welcome screens for SIP/H.323 callers.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const themes = await pexipListAll(
          `${CONFIG_BASE}/ivr_theme/`,
          g,
        );

        context.logger.info("Found {count} IVR themes", {
          count: themes.length,
        });

        return {
          data: {
            attributes: { themes, count: themes.length },
            name: "ivr-themes",
          },
        };
      },
    },

    // --- Media library ---

    listMedia: {
      description:
        "List all media library entries (hold music, IVR audio, playback content).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const media = await pexipListAll(
          `${CONFIG_BASE}/media_library/`,
          g,
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

    listPlaylists: {
      description: "List all media playlists.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const playlists = await pexipListAll(
          `${CONFIG_BASE}/playlist/`,
          g,
        );

        context.logger.info("Found {count} playlists", {
          count: playlists.length,
        });

        return {
          data: {
            attributes: { playlists, count: playlists.length },
            name: "playlists",
          },
        };
      },
    },

    createPlaylist: {
      description: "Create a media playlist for IVR or playback service.",
      arguments: z.object({
        name: z.string().describe("Playlist name"),
        description: z.string().optional().describe("Playlist description"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const body: Record<string, unknown> = { name: args.name };
        if (args.description) body.description = args.description;

        await pexipApi(`${CONFIG_BASE}/playlist/`, g, {
          method: "POST",
          body,
        });

        context.logger.info("Created playlist '{name}'", {
          name: args.name,
        });

        return {
          data: {
            attributes: { name: args.name },
            name: `playlist-${sanitizeId(args.name)}`,
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full branding inventory: packages, webapp paths, IVR themes, media library, and playlists.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [packages, paths, themes, media, playlists] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/webapp_branding_package/`, g),
          pexipListAll(`${CONFIG_BASE}/webapp_path/`, g),
          pexipListAll(`${CONFIG_BASE}/ivr_theme/`, g),
          pexipListAll(`${CONFIG_BASE}/media_library/`, g),
          pexipListAll(`${CONFIG_BASE}/playlist/`, g),
        ]);

        context.logger.info(
          "Branding inventory: {packages} packages, {paths} paths, {themes} themes, {media} media, {playlists} playlists",
          {
            packages: packages.length,
            paths: paths.length,
            themes: themes.length,
            media: media.length,
            playlists: playlists.length,
          },
        );

        return {
          data: {
            attributes: {
              packages,
              webappPaths: paths,
              ivrThemes: themes,
              mediaLibrary: media,
              playlists,
            },
            name: "branding-inventory",
          },
        };
      },
    },
  },
};
