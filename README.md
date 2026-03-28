# swamp-pexip

Swamp extension for managing Pexip Infinity video conferencing infrastructure.

## Overview

This extension provides five model types covering the full Pexip Infinity v39 management API surface: conference and VMR management, node deployment and capacity planning, Microsoft Teams and Google Meet integrations, One Touch Join (OTJ) calendar connectors, and platform-level administration.

## Models

- **conference** — VMR lifecycle, conference control, participant management, call routing rules, and themes
- **deploy** — Conferencing node provisioning, capacity validation, location and system image management
- **integration** — Microsoft Teams CVI, Google Meet, Skype for Business, and external policy server configurations
- **otj** — One Touch Join calendar connectors (Exchange, Google, hybrid), scheduling rules, and connector health
- **platform** — Global configuration, TLS certificates, DNS/NTP, licensing, LDAP sync, and event sinks

## Installation

```bash
swamp extension install dougschaefer6/swamp-pexip
```

## Credentials

The extension expects Pexip Management Node credentials stored in a swamp vault:

```bash
swamp vault set <vault-name> pexip-base-url https://your-mgmt-node.example.com
swamp vault set <vault-name> pexip-username admin
swamp vault set <vault-name> pexip-password <password>
```

## License

MIT
