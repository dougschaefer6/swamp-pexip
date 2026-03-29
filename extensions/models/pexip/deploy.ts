import { z } from "npm:zod@4.3.6";
import {
  az,
  AzureGlobalArgsSchema,
  requireResourceGroup,
  sanitizeInstanceName,
} from "../azure/_helpers.ts";

/**
 * Pexip Infinity Azure Deployment Model
 *
 * Manages the Azure infrastructure side of a Pexip Infinity deployment:
 * - VHD image upload and managed image creation
 * - VM provisioning (management + conferencing nodes)
 * - VM lifecycle (start, stop, deallocate, resize)
 * - Dynamic bursting support
 *
 * Per Pexip v39 Azure Deployment Guide:
 * - Management Node: D4ls_v5
 * - Conferencing Node (small): D8ls_v5 (10-11 Full HD calls)
 * - Conferencing Node (medium): D16ls_v5 (20-22 Full HD calls)
 * - Proxying Edge: D4ls_v5
 * - OS username is always "admin"
 * - SSH key auth preferred over password
 */

const PexipVmSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    location: z.string(),
    resourceGroup: z.string(),
    vmSize: z.string(),
    powerState: z.string().optional(),
    privateIp: z.string().optional(),
    publicIp: z.string().optional(),
    role: z.enum(["management", "conferencing", "proxying"]).optional(),
    pexipVersion: z.string().optional(),
    osDiskName: z.string().optional(),
  })
  .passthrough();

const PexipImageSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    location: z.string(),
    resourceGroup: z.string(),
    sourceVhd: z.string().optional(),
    pexipVersion: z.string().optional(),
    role: z.enum(["management", "conferencing"]).optional(),
  })
  .passthrough();

// Recommended Azure VM sizes per Pexip v39 deployment guide
const PEXIP_VM_SIZES = {
  management: "Standard_D4ls_v5",
  "conferencing-small": "Standard_D8ls_v5",
  "conferencing-medium": "Standard_D16ls_v5",
  "conferencing-large": "Standard_D32ls_v5",
  proxying: "Standard_D4ls_v5",
} as const;

// Pexip v39 hardware requirements and capacity constants
const PEXIP_SPECS = {
  management: {
    minVcpu: 4,
    minRamGb: 4, // 1 GB per vCPU
    minStorageGb: 100,
    minIops: 800,
    maxManagedNodes: 30, // beyond 30 requires upsized mgmt node
  },
  conferencing: {
    minVcpu: 4,
    maxVcpu: 48, // up to 56 tested on fast processors
    ramPerVcpu: 1, // 1 GB per vCPU
    minStorageGb: 50,
    minIops: 250,
    minClockGhz: 2.6, // Ice Lake + HT
    bandwidthPerCallMbps: { min: 0.5, typical: 1.5, max: 3.0 },
    maxBandwidthPerParticipant: 6_000_000, // 6 Mbps
    minBandwidthPerParticipant: 8_000, // 8 kbps (G.729 audio)
  },
  proxying: {
    minVcpu: 4,
    maxVcpu: 8,
    minRamGb: 4,
    maxRamGb: 8,
    minStorageGb: 50,
    minIops: 250,
  },
  // Azure call capacity per VM size (from Pexip v39 Azure guide)
  azureCapacity: {
    "Standard_D8ls_v5": {
      fullHd: "10-11",
      hd: "18-19",
      sd: "38-44",
      audio: "360-400",
    },
    "Standard_D16ls_v5": {
      fullHd: "20-22",
      hd: "36-38",
      sd: "72-80",
      audio: "670-720",
    },
    "Standard_D32ls_v5": {
      fullHd: "~38",
      hd: "~70",
      sd: "~150",
      audio: "~1350",
    },
  },
  // VHD source URLs
  vhdBaseUrl: "https://pexipas.blob.core.windows.net/infinity",
  currentVersion: "39-1-0-83067-0-0",
  // Service types (for validation)
  serviceTypes: [
    "conference",
    "lecture",
    "gateway",
    "two_stage_dialing",
    "media_playback",
    "test_call",
  ],
} as const;

export const model = {
  type: "@dougschaefer/pexip-deploy",
  version: "2026.03.26.1",
  globalArguments: AzureGlobalArgsSchema,
  resources: {
    vm: {
      description: "Pexip Infinity VM deployed in Azure",
      schema: PexipVmSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    image: {
      description: "Pexip VHD managed disk image in Azure",
      schema: PexipImageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    // --- Image management ---

    getCapacity: {
      description:
        "Show expected call capacity for a given Azure VM size based on Pexip v39 benchmarks.",
      arguments: z.object({
        vmSize: z
          .enum([
            "Standard_D8ls_v5",
            "Standard_D16ls_v5",
            "Standard_D32ls_v5",
          ])
          .describe("Azure VM size for a conferencing node"),
      }),
      execute: (args, context) => {
        const cap = PEXIP_SPECS.azureCapacity[
          args.vmSize as keyof typeof PEXIP_SPECS.azureCapacity
        ];

        if (!cap) {
          throw new Error(`No capacity data for ${args.vmSize}`);
        }

        context.logger.info(
          "{size}: Full HD={fullHd}, HD={hd}, SD={sd}, Audio={audio}",
          { size: args.vmSize, ...cap },
        );

        return {
          dataOutputs: [
            {
              name: "capacity",
              content: JSON.stringify({
                vmSize: args.vmSize,
                ...cap,
                source: "Pexip Infinity v39 Azure Deployment Guide",
                note:
                  "Actual capacity varies based on Azure-allocated processor variant",
              }),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite",
                tags: { type: "data" },
              },
            },
          ],
        };
      },
    },

    validateNodeSpec: {
      description:
        "Validate a VM specification against Pexip v39 hardware requirements. Returns warnings for any spec violations.",
      arguments: z.object({
        role: z
          .enum(["management", "conferencing", "proxying"])
          .describe("Node role"),
        vcpu: z.number().describe("Number of vCPUs"),
        ramGb: z.number().describe("RAM in GB"),
        storageGb: z.number().describe("Storage in GB"),
      }),
      execute: (args, context) => {
        const warnings: string[] = [];
        const spec = args.role === "management"
          ? PEXIP_SPECS.management
          : args.role === "conferencing"
          ? PEXIP_SPECS.conferencing
          : PEXIP_SPECS.proxying;

        if (args.vcpu < spec.minVcpu) {
          warnings.push(
            `vCPU ${args.vcpu} below minimum ${spec.minVcpu} for ${args.role} node`,
          );
        }
        if ("maxVcpu" in spec && args.vcpu > spec.maxVcpu) {
          warnings.push(
            `vCPU ${args.vcpu} exceeds maximum ${spec.maxVcpu} for ${args.role} node`,
          );
        }

        const minRam = "ramPerVcpu" in spec
          ? args.vcpu * spec.ramPerVcpu
          : "minRamGb" in spec
          ? spec.minRamGb
          : 4;
        if (args.ramGb < minRam) {
          warnings.push(
            `RAM ${args.ramGb}GB below minimum ${minRam}GB for ${args.role} node (${args.vcpu} vCPU)`,
          );
        }

        if (args.storageGb < spec.minStorageGb) {
          warnings.push(
            `Storage ${args.storageGb}GB below minimum ${spec.minStorageGb}GB for ${args.role} node`,
          );
        }

        if (
          args.role === "management" &&
          args.vcpu >= 4 &&
          args.ramGb >= 4 &&
          args.storageGb >= 100
        ) {
          // Check if managing > 30 nodes would need upsize
          warnings.push(
            "Management node at baseline spec supports up to 30 conferencing nodes. Beyond 30 requires upsizing — contact Pexip SA.",
          );
        }

        const valid = warnings.length === 0;

        context.logger.info(
          "Validation {result} for {role} node: {vcpu} vCPU, {ram}GB RAM, {storage}GB storage",
          {
            result: valid ? "PASSED" : `WARNINGS (${warnings.length})`,
            role: args.role,
            vcpu: args.vcpu,
            ram: args.ramGb,
            storage: args.storageGb,
          },
        );

        if (!valid) {
          for (const w of warnings) {
            context.logger.warning(w);
          }
        }

        return {
          dataOutputs: [
            {
              name: "validation",
              content: JSON.stringify({
                role: args.role,
                vcpu: args.vcpu,
                ramGb: args.ramGb,
                storageGb: args.storageGb,
                valid,
                warnings,
              }),
              metadata: {
                contentType: "application/json",
                lifetime: "ephemeral",
                tags: { type: "data" },
              },
            },
          ],
        };
      },
    },

    downloadVhd: {
      description:
        "Download Pexip Infinity VHD images from Pexip's Azure blob storage into your storage account. Source: https://pexipas.blob.core.windows.net/infinity/{version}/",
      arguments: z.object({
        version: z
          .string()
          .default("39-1-0-83067-0-0")
          .describe(
            "Pexip version string (e.g., 39-1-0-83067-0-0 for v39.1)",
          ),
        role: z
          .enum(["management", "conferencing", "both"])
          .default("both")
          .describe("Which VHD(s) to download"),
        storageAccount: z
          .string()
          .describe("Destination storage account name"),
        containerName: z
          .string()
          .default("pexip-images")
          .describe("Destination blob container name"),
        resourceGroup: z.string().optional().describe("Storage account RG"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);
        const baseUrl =
          `https://pexipas.blob.core.windows.net/infinity/${args.version}`;

        const roles = args.role === "both"
          ? ["management-node", "conferencing-node"]
          : [
            `${
              args.role === "management" ? "management" : "conferencing"
            }-node`,
          ];

        for (const nodeType of roles) {
          const sourceUri = `${baseUrl}/${nodeType}.vhd`;
          const destBlob = `pexip-infinity-${args.version}-${nodeType}.vhd`;

          context.logger.info("Starting VHD copy: {src} → {dest}", {
            src: sourceUri,
            dest: `${args.storageAccount}/${args.containerName}/${destBlob}`,
          });

          // Get storage account key for azcopy
          const keys = (await az(
            [
              "storage",
              "account",
              "keys",
              "list",
              "--account-name",
              args.storageAccount,
              "--resource-group",
              rg,
            ],
            g.subscriptionId,
          )) as Array<{ value: string }>;

          await az(
            [
              "storage",
              "blob",
              "copy",
              "start",
              "--source-uri",
              sourceUri,
              "--destination-container",
              args.containerName,
              "--destination-blob",
              destBlob,
              "--account-name",
              args.storageAccount,
              "--account-key",
              keys[0].value,
            ],
            g.subscriptionId,
          );

          context.logger.info("VHD copy initiated for {type}", {
            type: nodeType,
          });
        }

        return { dataHandles: [] };
      },
    },

    createImageFromVhd: {
      description:
        "Create a managed disk image from a Pexip VHD in blob storage. Run this after uploading the VHD to the storage account.",
      arguments: z.object({
        name: z
          .string()
          .describe("Image name (e.g., pexip-v39-management-node)"),
        resourceGroup: z.string().optional().describe("Resource group"),
        location: z.string().default("centralus").describe("Azure region"),
        vhdUri: z
          .string()
          .describe(
            "Full URI to the VHD blob (e.g., https://yourstorageaccount.blob.core.windows.net/pexip-images/pexip-mgmt-v39.vhd)",
          ),
        role: z
          .enum(["management", "conferencing"])
          .describe("Pexip node role this image is for"),
        osType: z.enum(["Linux"]).default("Linux"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        await az(
          [
            "image",
            "create",
            "--name",
            args.name,
            "--resource-group",
            rg,
            "--location",
            args.location,
            "--source",
            args.vhdUri,
            "--os-type",
            args.osType,
            "--hyper-v-generation",
            "V1",
          ],
          g.subscriptionId,
        );

        context.logger.info("Created image {name} from VHD", {
          name: args.name,
        });

        const image = await az(
          ["image", "show", "--name", args.name, "--resource-group", rg],
          g.subscriptionId,
        );

        const handle = await context.writeResource(
          "image",
          sanitizeInstanceName(args.name),
          {
            ...(image as Record<string, unknown>),
            sourceVhd: args.vhdUri,
            role: args.role,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listImages: {
      description: "List all Pexip managed disk images in a resource group.",
      arguments: z.object({
        resourceGroup: z.string().optional().describe("Resource group"),
        filter: z
          .string()
          .optional()
          .describe("Name filter (substring match)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        let images = (await az(
          ["image", "list", "--resource-group", rg],
          g.subscriptionId,
        )) as Array<Record<string, unknown>>;

        if (args.filter) {
          images = images.filter((img) =>
            (img.name as string)
              .toLowerCase()
              .includes(args.filter.toLowerCase())
          );
        }

        context.logger.info("Found {count} images", {
          count: images.length,
        });

        const handles = [];
        for (const img of images) {
          const handle = await context.writeResource(
            "image",
            sanitizeInstanceName(img.name as string),
            img,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    // --- VM provisioning ---

    deployNode: {
      description:
        "Deploy a Pexip Infinity node VM from a managed image. Configures the VM per Pexip Azure deployment guide.",
      arguments: z.object({
        name: z.string().describe("VM name (e.g., PexipMgmt)"),
        resourceGroup: z.string().optional().describe("Resource group"),
        location: z.string().default("centralus").describe("Azure region"),
        role: z
          .enum(["management", "conferencing", "proxying"])
          .describe("Node role"),
        size: z
          .enum([
            "Standard_D4ls_v5",
            "Standard_D8ls_v5",
            "Standard_D16ls_v5",
            "Standard_D32ls_v5",
          ])
          .optional()
          .describe(
            "VM size (defaults to Pexip-recommended size for the role)",
          ),
        imageName: z.string().describe("Managed image name to deploy from"),
        imageResourceGroup: z
          .string()
          .optional()
          .describe("Resource group containing the image (if different)"),
        subnetId: z
          .string()
          .describe(
            "Full subnet resource ID for the VM NIC",
          ),
        privateIp: z
          .string()
          .optional()
          .describe("Static private IP (omit for DHCP)"),
        publicIp: z
          .boolean()
          .optional()
          .default(false)
          .describe("Create and attach a public IP"),
        sshKeyPath: z
          .string()
          .optional()
          .describe("Path to SSH public key file"),
        adminPassword: z
          .string()
          .optional()
          .describe("Admin password (if not using SSH keys)"),
        osDiskType: z
          .enum(["StandardSSD_LRS", "Premium_LRS"])
          .optional()
          .default("StandardSSD_LRS")
          .describe("OS disk storage SKU"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        // Determine VM size based on role if not specified
        const vmSize = args.size ||
          (args.role === "management"
            ? PEXIP_VM_SIZES.management
            : args.role === "conferencing"
            ? PEXIP_VM_SIZES["conferencing-small"]
            : PEXIP_VM_SIZES.proxying);

        // Build the image reference
        const imageRg = args.imageResourceGroup || rg;
        const imageId =
          `/subscriptions/${g.subscriptionId}/resourceGroups/${imageRg}/providers/Microsoft.Compute/images/${args.imageName}`;

        const cmdArgs = [
          "vm",
          "create",
          "--name",
          args.name,
          "--resource-group",
          rg,
          "--location",
          args.location,
          "--image",
          imageId,
          "--size",
          vmSize,
          "--admin-username",
          "admin",
          "--subnet",
          args.subnetId,
          "--os-disk-name",
          `${args.name}-osDisk`,
          "--storage-sku",
          args.osDiskType,
          "--nics",
          `vmnic-${args.name.toLowerCase()}`,
        ];

        // Authentication
        if (args.sshKeyPath) {
          cmdArgs.push(
            "--authentication-type",
            "ssh",
            "--ssh-key-values",
            args.sshKeyPath,
          );
        } else if (args.adminPassword) {
          cmdArgs.push(
            "--authentication-type",
            "password",
            "--admin-password",
            args.adminPassword,
          );
        }

        // Static IP
        if (args.privateIp) {
          cmdArgs.push("--private-ip-address", args.privateIp);
        }

        // Public IP
        if (!args.publicIp) {
          cmdArgs.push("--public-ip-address", "");
        }

        await az(cmdArgs, g.subscriptionId);

        context.logger.info(
          "Deployed {role} node {name} ({size}) in {rg}",
          { role: args.role, name: args.name, size: vmSize, rg },
        );

        // Fetch VM details
        const vm = (await az(
          [
            "vm",
            "show",
            "--name",
            args.name,
            "--resource-group",
            rg,
            "--show-details",
          ],
          g.subscriptionId,
        )) as Record<string, unknown>;

        const handle = await context.writeResource(
          "vm",
          sanitizeInstanceName(args.name),
          {
            ...(vm as Record<string, unknown>),
            role: args.role,
            vmSize,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- VM lifecycle ---

    listNodes: {
      description:
        "List all Pexip VMs in a resource group with their power state.",
      arguments: z.object({
        resourceGroup: z.string().optional().describe("Resource group"),
        filter: z
          .string()
          .optional()
          .describe("Name filter (substring match)"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        let vms = (await az(
          ["vm", "list", "--resource-group", rg, "--show-details"],
          g.subscriptionId,
        )) as Array<Record<string, unknown>>;

        if (args.filter) {
          vms = vms.filter((vm) =>
            (vm.name as string)
              .toLowerCase()
              .includes(args.filter.toLowerCase())
          );
        }

        context.logger.info("Found {count} VMs", { count: vms.length });

        const handles = [];
        for (const vm of vms) {
          const handle = await context.writeResource(
            "vm",
            sanitizeInstanceName(vm.name as string),
            vm,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    startNode: {
      description: "Start a deallocated Pexip node VM.",
      arguments: z.object({
        name: z.string().describe("VM name"),
        resourceGroup: z.string().optional().describe("Resource group"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        await az(
          ["vm", "start", "--name", args.name, "--resource-group", rg],
          g.subscriptionId,
        );

        context.logger.info("Started VM {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    stopNode: {
      description:
        "Stop (deallocate) a Pexip node VM. This stops billing for compute.",
      arguments: z.object({
        name: z.string().describe("VM name"),
        resourceGroup: z.string().optional().describe("Resource group"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        await az(
          [
            "vm",
            "deallocate",
            "--name",
            args.name,
            "--resource-group",
            rg,
          ],
          g.subscriptionId,
        );

        context.logger.info("Deallocated VM {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },

    resizeNode: {
      description:
        "Resize a Pexip node VM. VM must be deallocated first for most size changes.",
      arguments: z.object({
        name: z.string().describe("VM name"),
        resourceGroup: z.string().optional().describe("Resource group"),
        size: z
          .enum([
            "Standard_D4ls_v5",
            "Standard_D8ls_v5",
            "Standard_D16ls_v5",
            "Standard_D32ls_v5",
          ])
          .describe("New VM size"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        await az(
          [
            "vm",
            "resize",
            "--name",
            args.name,
            "--resource-group",
            rg,
            "--size",
            args.size,
          ],
          g.subscriptionId,
        );

        context.logger.info("Resized VM {name} to {size}", {
          name: args.name,
          size: args.size,
        });

        return { dataHandles: [] };
      },
    },

    deleteNode: {
      description:
        "Delete a Pexip node VM and its associated resources (NIC, OS disk, public IP).",
      arguments: z.object({
        name: z.string().describe("VM name"),
        resourceGroup: z.string().optional().describe("Resource group"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        await az(
          [
            "vm",
            "delete",
            "--name",
            args.name,
            "--resource-group",
            rg,
            "--yes",
            "--force-deletion",
            "true",
          ],
          g.subscriptionId,
        );

        // Clean up NIC and OS disk
        try {
          await az(
            [
              "network",
              "nic",
              "delete",
              "--name",
              `vmnic-${args.name.toLowerCase()}`,
              "--resource-group",
              rg,
            ],
            g.subscriptionId,
          );
        } catch { /* NIC may not exist */ }

        try {
          await az(
            [
              "disk",
              "delete",
              "--name",
              `${args.name}-osDisk`,
              "--resource-group",
              rg,
              "--yes",
            ],
            g.subscriptionId,
          );
        } catch { /* Disk may not exist */ }

        context.logger.info("Deleted VM {name} and associated resources", {
          name: args.name,
        });

        return { dataHandles: [] };
      },
    },

    // --- Snapshot for backup ---

    snapshotNode: {
      description:
        "Create a disk snapshot of a Pexip node for backup/rollback.",
      arguments: z.object({
        name: z.string().describe("VM name to snapshot"),
        resourceGroup: z.string().optional().describe("Resource group"),
        snapshotName: z
          .string()
          .optional()
          .describe("Snapshot name (defaults to {vmName}-snap-{timestamp})"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const rg = requireResourceGroup(args.resourceGroup, g.resourceGroup);

        const snapName = args.snapshotName ||
          `${args.name}-snap-${new Date().toISOString().replace(/[:.]/g, "-")}`;

        // Get the OS disk ID
        const vm = (await az(
          ["vm", "show", "--name", args.name, "--resource-group", rg],
          g.subscriptionId,
        )) as Record<string, unknown>;

        const storageProfile = vm.storageProfile as {
          osDisk: { managedDisk: { id: string } };
        };
        const osDiskId = storageProfile.osDisk.managedDisk.id;

        await az(
          [
            "snapshot",
            "create",
            "--name",
            snapName,
            "--resource-group",
            rg,
            "--source",
            osDiskId,
          ],
          g.subscriptionId,
        );

        context.logger.info("Created snapshot {snap} from {vm}", {
          snap: snapName,
          vm: args.name,
        });

        return { dataHandles: [] };
      },
    },
  },
};
