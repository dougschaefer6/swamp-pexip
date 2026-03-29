import { z } from "npm:zod@4.3.6";
import {
  CONFIG_BASE,
  pexipApi,
  PexipGlobalArgsSchema,
  pexipListAll,
  STATUS_BASE,
} from "./_client.ts";

/**
 * Pexip Infinity license management — installed licenses, usage tracking,
 * license requests, and compliance monitoring.
 *
 * License types:
 *   - Concurrent: maximum simultaneous call ports
 *   - Activatable: named user licenses
 *   - Hybrid: combination of concurrent and activatable
 *
 * Each license has an entitlement ID, fulfillment ID, feature set, capacity
 * counts, and expiration date. The status API provides real-time usage
 * against allocated capacity.
 */

export const model = {
  type: "@dougschaefer/pexip-license",
  version: "2026.03.29.1",
  globalArguments: PexipGlobalArgsSchema,

  methods: {
    list: {
      description:
        "List all installed licenses with entitlements, capacities, features, and expiration dates.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const licenses = await pexipListAll(
          `${CONFIG_BASE}/licence/`,
          g,
        );

        context.logger.info("Found {count} licenses", {
          count: licenses.length,
        });

        return {
          data: {
            attributes: { licenses, count: licenses.length },
            name: "licenses",
          },
        };
      },
    },

    getStatus: {
      description:
        "Get real-time license usage: current concurrent calls, activatable users, and capacity against limits.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const status = await pexipApi(
          `${STATUS_BASE}/licensing/`,
          g,
        );

        context.logger.info("License status retrieved");

        return {
          data: {
            attributes: status as Record<string, unknown>,
            name: "license-status",
          },
        };
      },
    },

    listRequests: {
      description:
        "List license activation requests (pending, completed, or failed).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const requests = await pexipListAll(
          `${CONFIG_BASE}/licence_request/`,
          g,
        );

        context.logger.info("Found {count} license requests", {
          count: requests.length,
        });

        return {
          data: {
            attributes: { requests, count: requests.length },
            name: "license-requests",
          },
        };
      },
    },

    checkCompliance: {
      description:
        "Check license compliance: compares current usage against allocated capacity and flags any overages or approaching limits.",
      arguments: z.object({
        warningThresholdPercent: z
          .number()
          .default(80)
          .describe(
            "Percentage of capacity at which to flag a warning (default: 80%)",
          ),
      }),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [licenses, status] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/licence/`, g),
          pexipApi(`${STATUS_BASE}/licensing/`, g) as Promise<
            Record<string, unknown>
          >,
        ]);

        const warnings: Array<Record<string, unknown>> = [];
        const overages: Array<Record<string, unknown>> = [];

        // Check each license for capacity
        for (const lic of licenses) {
          const expiration = lic.expiration_date as string;

          // Check expiration
          if (expiration) {
            const expiresAt = new Date(expiration);
            const daysUntilExpiry = Math.floor(
              (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
            );
            if (daysUntilExpiry < 0) {
              overages.push({
                type: "expired",
                entitlementId: lic.entitlement_id,
                expiredDaysAgo: Math.abs(daysUntilExpiry),
              });
            } else if (daysUntilExpiry < 30) {
              warnings.push({
                type: "expiring_soon",
                entitlementId: lic.entitlement_id,
                daysUntilExpiry,
              });
            }
          }
        }

        const compliant = overages.length === 0;

        context.logger.info(
          "License compliance: {status} ({warnings} warnings, {overages} overages)",
          {
            status: compliant ? "COMPLIANT" : "NON-COMPLIANT",
            warnings: warnings.length,
            overages: overages.length,
          },
        );

        return {
          data: {
            attributes: {
              compliant,
              licenses: licenses.length,
              status,
              warnings,
              overages,
              checkedAt: new Date().toISOString(),
            },
            name: "license-compliance",
          },
        };
      },
    },

    // --- Inventory ---

    inventory: {
      description:
        "Full license inventory: all licenses, current usage status, and compliance check.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;

        const [licenses, requests, status] = await Promise.all([
          pexipListAll(`${CONFIG_BASE}/licence/`, g),
          pexipListAll(`${CONFIG_BASE}/licence_request/`, g),
          pexipApi(`${STATUS_BASE}/licensing/`, g) as Promise<
            Record<string, unknown>
          >,
        ]);

        context.logger.info(
          "License inventory: {licenses} licenses, {requests} requests",
          { licenses: licenses.length, requests: requests.length },
        );

        return {
          data: {
            attributes: { licenses, requests, status },
            name: "license-inventory",
          },
        };
      },
    },
  },
};
