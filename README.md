# @dougschaefer/pexip-infinity

A [Swamp](https://github.com/systeminit/swamp) extension that manages Pexip Infinity video conferencing infrastructure through the management node API. Five model types cover the full platform lifecycle across 113 methods: conference management (VMRs, aliases, auto-participants, call routing, and live conference control), node deployment and capacity planning via Azure CLI, platform integrations (Microsoft Teams CVI, SIP trunks, LDAP, TURN, identity providers, and external policy servers), One-Touch-Join calendar connectors for Exchange, Google Workspace, and Office 365, and platform administration including system configuration, licensing, alarms, backups, TLS certificates, and diagnostic snapshots.

## Models / Methods

### pexip-conference (25 methods)

Conference and VMR lifecycle, live conference control, call routing, and history.

| Method | Description |
|--------|-------------|
| `listVmrs` | List all Virtual Meeting Rooms, optionally filtered by tag |
| `createVmr` | Create a VMR with aliases, PINs, guest access, participant limits, and service type |
| `deleteVmr` | Delete a VMR by name |
| `listCallRoutingRules` | List all gateway routing rules for incoming and outgoing call matching |
| `createCallRoutingRule` | Create a gateway routing rule with regex match, priority, protocol filter, and media encryption |
| `listGatewayRules` | List gateway routing rules (outbound/interop) |
| `listActiveConferences` | List currently active conferences with participant counts |
| `disconnectParticipant` | Disconnect a specific participant from an active conference |
| `lockConference` | Lock or unlock an active conference |
| `muteParticipant` | Mute or unmute a specific participant |
| `muteAllGuests` | Mute or unmute all guest participants in a conference |
| `transferParticipant` | Transfer a participant to a different conference with a specified role |
| `changeParticipantRole` | Change a participant between chair and guest roles |
| `changeLayout` | Change the video layout of an active conference (1:7, teams, ac, 2x2, 3x3, 4x4, 5x5, etc.) |
| `getConferenceHistory` | Retrieve conference history records with optional time-range filtering |
| `listAliases` | List all conference aliases across all VMRs with substring filtering |
| `addAlias` | Add a SIP/H.323/WebRTC alias to an existing conference |
| `deleteAlias` | Remove an alias by ID |
| `listAutoParticipants` | List automatically dialed participants (RTMP streaming, recording, always-on endpoints) |
| `createAutoParticipant` | Add an auto-dial participant with protocol, role, DTMF sequence, and streaming flag |
| `deleteAutoParticipant` | Remove an auto-dial participant by ID |
| `getParticipantHistory` | Get participant-level CDRs (codec, quality, disconnect reason) with time and conference filters |
| `getParticipantMediaHistory` | Get media stream history for a participant (bitrate, codec, packet loss, jitter) |
| `listScheduledConferences` | List time-bounded scheduled conferences |
| `listRecurringConferences` | List recurring conference definitions |

### pexip-deploy (12 methods)

Azure VM provisioning, image management, capacity planning, and node lifecycle.

| Method | Description |
|--------|-------------|
| `getCapacity` | Show expected call capacity (Full HD, HD, SD, audio-only) for a given Azure VM size per Pexip v39 benchmarks |
| `validateNodeSpec` | Validate vCPU, RAM, and storage against Pexip v39 hardware requirements for a given node role |
| `downloadVhd` | Copy Pexip VHD images from Pexip's public Azure blob storage into your storage account |
| `createImageFromVhd` | Create a managed disk image from a VHD blob for VM provisioning |
| `listImages` | List Pexip managed disk images in a resource group with optional name filtering |
| `deployNode` | Deploy a Pexip node VM from a managed image with role-based size defaults, subnet placement, and static IP |
| `listNodes` | List all Pexip VMs in a resource group with power state |
| `startNode` | Start a deallocated node VM |
| `stopNode` | Deallocate a node VM (stops compute billing) |
| `resizeNode` | Resize a node VM to a different D-series SKU (requires prior deallocation for most changes) |
| `deleteNode` | Delete a node VM and clean up associated NIC and OS disk resources |
| `snapshotNode` | Create a disk snapshot of a node's OS disk for backup or rollback |

### pexip-integration (36 methods)

Platform integrations: event sinks, TLS, SIP, LDAP, Teams CVI, TURN, identity providers, media, branding, and monitoring.

| Method | Description |
|--------|-------------|
| `listEventSinks` | List configured event sinks for conference/participant event forwarding |
| `createEventSink` | Create an HTTP(S) event sink with optional basic auth, TLS verification, API version, and bulk mode |
| `deleteEventSink` | Delete an event sink by name |
| `listCertificates` | List all TLS certificates on the platform |
| `uploadCertificate` | Upload a PEM certificate with private key and optional intermediate chain |
| `listSipRegistrations` | List SIP registrations (trunks to external SBC/proxy) |
| `createSipRegistration` | Create a SIP registration with proxy address, transport protocol, and port |
| `listLdapSources` | List LDAP/AD directory sources for contact sync |
| `listTeamsConnectors` | List Microsoft Teams connector configurations |
| `syncLdap` | Trigger an immediate LDAP directory sync (normally runs daily at 01:00 UTC) |
| `listIdentityProviders` | List SAML/OIDC identity providers for conference participant SSO |
| `createIdentityProvider` | Configure an identity provider for participant authentication |
| `deleteIdentityProvider` | Remove an identity provider configuration |
| `listIdentityProviderGroups` | List identity provider groups controlling IdP user access to services |
| `listUserGroups` | List user groups for access control |
| `listMediaLibrary` | List media library entries (hold music, IVR audio, playback service content) |
| `listPlaylists` | List media playlists |
| `createPlaylist` | Create a media playlist for playback service or IVR |
| `listBrandingPackages` | List web app branding packages for per-client meeting experiences |
| `listWebAppPaths` | List web app path aliases (custom URLs for branded join pages) |
| `createWebAppPath` | Create a web app path alias (e.g., /meet/clientname) with optional branding |
| `listCsrs` | List certificate signing requests |
| `createCsr` | Generate a CSR on the management node with common name and SANs (private key stays on-box) |
| `listAzureTenants` | List Azure/Entra tenant configurations for Teams CVI |
| `createAzureTenant` | Configure an Azure/Entra tenant for Teams CVI integration |
| `listTurnServers` | List TURN server configurations for NAT traversal |
| `createTurnServer` | Configure a TURN server with address, port, credentials, and transport protocol |
| `listRegisteredDevices` | List all registered device aliases |
| `listIvrThemes` | List IVR themes (branding, hold music, prompts) |
| `listCaCertificates` | List trusted CA certificates |
| `uploadCaCertificate` | Upload a trusted CA certificate in PEM format |
| `listPolicyServers` | List external policy server configurations |
| `createPolicyServer` | Configure an external policy server for dynamic call routing decisions |
| `configureAutoBackup` | Enable or disable automatic scheduled backups |
| `configureSnmp` | Configure SNMP monitoring with community string and allowed subnets |
| `configureSyslog` | Configure remote syslog forwarding with server address, port, and transport |

### pexip-otj (16 methods)

One-Touch-Join calendar connectors: endpoints, groups, profiles, meeting rules, calendar deployments, and status.

| Method | Description |
|--------|-------------|
| `listEndpoints` | List OTJ endpoints (room systems with calendar integration), optionally filtered by group |
| `createEndpoint` | Register a room system for OTJ with alias, calendar ID, protocol, and optional direct IP for Cisco xAPI push |
| `deleteEndpoint` | Remove an OTJ endpoint by name |
| `listEndpointGroups` | List OTJ endpoint groups (logical collections of rooms) |
| `createEndpointGroup` | Create an endpoint group with optional integration profile binding |
| `listProfiles` | List OTJ integration profiles |
| `createProfile` | Create an OTJ integration profile with system location binding |
| `listMeetingRules` | List meeting processing rules (URI pattern matching for dial strings) |
| `createMeetingRule` | Create a meeting processing rule with regex match, priority, and meeting type (Pexip, Teams, Google Meet, Webex, Zoom, etc.) |
| `listCalendarDeployments` | List calendar system deployments across Exchange, O365 Graph, and Google |
| `configureGraphDeployment` | Configure a Microsoft 365 Graph API calendar deployment |
| `configureExchangeDeployment` | Configure an Exchange on-premises calendar deployment |
| `configureGoogleDeployment` | Configure a Google Workspace calendar deployment |
| `getEndpointStatus` | Get OTJ endpoint status (last poll time, errors) |
| `listMeetings` | List active OTJ meetings (dial buttons pushed to endpoints) |
| `inventory` | Full OTJ inventory: profiles, groups, endpoints, and meeting processing rules in one call |

### pexip-platform (24 methods)

System configuration, node management, DNS/NTP, licensing, alarms, backups, and platform commands.

| Method | Description |
|--------|-------------|
| `getConfig` | Get global system configuration (DNS, NTP, SIP domain, enabled protocols, proxying mode) |
| `updateConfig` | Patch global configuration fields (SIP domain, protocol toggles, DNS/NTP servers) |
| `listNodes` | List all conferencing and proxying worker nodes registered to the platform |
| `getNodeStatus` | Get runtime status of all worker nodes (media load, signaling load, current calls, version) |
| `setMaintenanceMode` | Enable or disable maintenance mode on a conferencing node to drain calls before maintenance |
| `listDnsServers` | List configured DNS servers |
| `addDnsServer` | Add a DNS server by IP address |
| `listNtpServers` | List configured NTP servers |
| `addNtpServer` | Add an NTP server by address or FQDN |
| `getParticipantMedia` | Get live media stream statistics for an active participant (bitrate, codec, packet loss, jitter) |
| `getNodeStatistics` | Get detailed load statistics for a specific worker node |
| `listLocations` | List all system locations (logical groupings for nodes with overflow configuration) |
| `createLocation` | Create a system location with optional policy server and event sink URLs |
| `getLicenseStatus` | Get current license status, usage counts, and expiry |
| `listAlarms` | List all active platform alarms |
| `createBackup` | Create an encrypted configuration backup on the management node |
| `restoreBackup` | Restore a configuration backup by ID (overwrites current configuration) |
| `upgrade` | Initiate a platform upgrade after uploading the upgrade package |
| `takeSnapshot` | Take a diagnostic snapshot for Pexip support with configurable log duration |
| `dialParticipant` | Dial out to a SIP/H.323/RTMP destination and add it to a conference |
| `disconnectConference` | Disconnect all participants and end a conference |
| `startCloudNode` | Start a dynamic bursting cloud node in Azure by instance ID |
| `listBackups` | List available configuration backups |
| `inventory` | Full platform inventory: system config, worker nodes, locations, licenses, and alarms in one call |

## Installation

```bash
swamp extension pull @dougschaefer/pexip-infinity
```

## Setup

### 1. Store Pexip management node credentials

The conference, integration, OTJ, and platform models all authenticate against the Pexip management node API with a username and password.

```bash
swamp vault create local_encryption pexip
swamp vault put pexip base-url="https://your-mgmt-node.example.com" -f
swamp vault put pexip username="admin" -f
swamp vault put pexip password="YOUR_PASSWORD" -f
```

### 2. Create model instances

```bash
swamp model create @dougschaefer/pexip-conference my-pexip-conf \
  --global-arg 'baseUrl=${{ vault.get(pexip, base-url) }}' \
  --global-arg 'username=${{ vault.get(pexip, username) }}' \
  --global-arg 'password=${{ vault.get(pexip, password) }}'

swamp model create @dougschaefer/pexip-platform my-pexip-platform \
  --global-arg 'baseUrl=${{ vault.get(pexip, base-url) }}' \
  --global-arg 'username=${{ vault.get(pexip, username) }}' \
  --global-arg 'password=${{ vault.get(pexip, password) }}'
```

Repeat the same pattern for `pexip-integration`, `pexip-otj`, and `pexip-deploy`.

### 3. Store Azure credentials (deploy model only)

The deploy model provisions VMs through Azure CLI, so it needs a subscription ID and resource group.

```bash
swamp model create @dougschaefer/pexip-deploy my-pexip-deploy \
  --global-arg 'subscriptionId=YOUR_AZURE_SUB_ID' \
  --global-arg 'resourceGroup=YOUR_RG'
```

### 4. Run methods

```bash
swamp model method run my-pexip-conf listVmrs --json
swamp model method run my-pexip-platform inventory --json
swamp model method run my-pexip-deploy getCapacity \
  --arg 'vmSize=Standard_D16ls_v5' --json
```

## API Compatibility

Tested against Pexip Infinity v39. The extension uses the Pexip management REST API (JSON over HTTPS) and handles pagination automatically on all list operations, so methods return complete result sets regardless of the number of objects.

The deploy model uses both the Pexip API and Azure CLI (`az`) for VM provisioning. VM sizes default to the Pexip v39 Azure Deployment Guide recommendations: D4ls_v5 for management and proxying nodes, D8ls_v5 for small conferencing nodes, D16ls_v5 for medium, and D32ls_v5 for large.

## License

MIT -- see [LICENSE](LICENSE)
