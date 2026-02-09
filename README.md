# Meshtastic MQTT Web Client

A web client for sending and receiving encrypted messages to Meshtastic devices via MQTT. Connects to the public broker at `mqtt.meshtastic.org` using proper Meshtastic protobuf encoding with AES-CTR encryption — no external protobuf dependency required.

## Features

- **Send & receive** encrypted Meshtastic messages over MQTT
- **Protobuf & JSON** mode support (binary `2/e` and plaintext `2/json`)
- **AES-128/256-CTR** encryption with PSK shorthand expansion
- **Multi-channel** monitoring with per-channel decryption keys
- **Live activity log** with filtering by message type (text, position, telemetry, nodeinfo, routing, neighbors)
- **Node filtering** — click on sender/receiver in the activity log to filter
- **Payload preview** — inspect the exact MQTT topic and protobuf structure before sending
- **Settings management** — configure networks, keys, channels, and nodes
- **Zero external protobuf dependency** — custom encoder/decoder for Meshtastic wire format

## Quick Start

```bash
git clone https://github.com/valentinvieriu/mqtt-meshtastic.git
cd mqtt-meshtastic
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Docker

Pull the pre-built image from GitHub Container Registry:

```bash
docker pull ghcr.io/valentinvieriu/mqtt-meshtastic:latest
```

Run with default settings:

```bash
docker run --rm -p 3000:3000 -p 8080:8080 ghcr.io/valentinvieriu/mqtt-meshtastic:latest
```

Or with a `.env` file for custom configuration:

```bash
docker run --rm -p 3000:3000 -p 8080:8080 --env-file .env ghcr.io/valentinvieriu/mqtt-meshtastic:latest
```

Using Docker Compose:

```bash
cp .env.example .env   # edit as needed
docker compose up -d
```

The image supports `linux/amd64` and `linux/arm64`.

## Configuration

Copy `.env.example` to `.env` and adjust values:

```
PORT=3000
WS_PORT=8080
MQTT_HOST=mqtt.meshtastic.org
MQTT_PORT=1883
MQTT_USERNAME=meshdev
MQTT_PASSWORD=large4cats
MQTT_ROOT=msh
MQTT_REGION=EU_868
MQTT_PATH=2/e
DEFAULT_CHANNEL=LongFast
DEFAULT_KEY=AQ==
GATEWAY_ID=!d844b556
```

See `.env.example` for full documentation of all options including `CHANNEL_KEYS` for multi-key decryption.

## Architecture

```
Browser (HTML/CSS/JS)
    │ WebSocket
Node.js Server
    │  ├─ Protobuf encode/decode
    │  ├─ AES-CTR encryption
    │  └─ HTTP static files + /api/config
    │ MQTT
mqtt.meshtastic.org
```

The server bridges WebSocket connections from the browser to the MQTT broker, handling protobuf encoding/decoding and encryption/decryption. The browser provides the UI for composing messages, managing subscriptions, and viewing the activity log.

## Tech Stack

- **Node.js** (ES Modules) — server runtime
- **mqtt.js** — MQTT client
- **ws** — WebSocket server for browser communication
- **Native crypto** — AES-CTR encryption, no external crypto libs
- **Tailwind CSS** — frontend styling

## How It Works

**Sending:** The browser composes a message and sends it over WebSocket. The server encodes it as a Meshtastic `ServiceEnvelope` → `MeshPacket` → `Data` protobuf, encrypts the payload with AES-CTR using the channel's PSK, and publishes to the MQTT broker.

**Receiving:** The server subscribes to MQTT topics, decodes incoming protobuf `ServiceEnvelope` messages, attempts decryption with known channel keys, and forwards decoded messages to all connected browsers via WebSocket.

## License

MIT
