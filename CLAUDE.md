# MQTT-Meshtastic

## Project Overview
A web client for sending encrypted messages to Meshtastic devices via the public MQTT broker at mqtt.meshtastic.org. Uses proper Meshtastic protobuf message format with custom encoder/decoder (no external protobuf dependency).

## Tech Stack
- Node.js (ES Modules)
- mqtt.js (MQTT client)
- ws (WebSocket for browser communication)
- Native crypto (AES-CTR encryption)
- Custom protobuf encoder/decoder (no external dependency)
- Tailwind CSS (frontend styling)

## Architecture
```
┌─────────────────┐
│   Web Browser   │
│  (HTML/CSS/JS)  │
└────────┬────────┘
         │ WebSocket (ws://localhost:8080)
┌────────▼────────────────────────┐
│    Node.js Server               │
│  ┌──────────────────────────┐   │
│  │ WebSocket Server (WS)    │   │
│  │ HTTP Server (Port 3000)  │   │
│  │ Protobuf Encode/Decode   │   │
│  │ AES-CTR Encryption       │   │
│  └────────────┬─────────────┘   │
└───────────────┼─────────────────┘
                │ MQTT (tcp://mqtt.meshtastic.org:1883)
      ┌─────────▼─────────┐
      │   MQTT Broker     │
      │ (Meshtastic Mesh) │
      └───────────────────┘
```

## Project Structure
```
src/
├── server/
│   ├── index.js          # Main entry, WebSocket + MQTT bridge
│   ├── config.js         # Environment configuration
│   ├── crypto.js         # AES-CTR encryption + channel hash
│   ├── protobuf.js       # Meshtastic protobuf encode/decode
│   ├── http-server.js    # Static file serving + /api/config
│   └── mqtt-client.js    # MQTT client wrapper with reconnect
└── public/
    ├── index.html        # Main UI (Tailwind CSS)
    ├── css/styles.css    # Custom styles
    └── js/
        ├── app.js            # Main app logic, state management
        ├── ws-client.js      # WebSocket client with auto-reconnect
        ├── message-builder.js # Node ID parsing, topic building
        └── ui.js             # DOM utilities, toasts, clipboard
```

## Configuration (.env)

See `.env.example` for a fully commented template. Copy it to `.env` and adjust values.

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
CHANNEL_KEYS={"LongFast":"AQ=="}
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `WS_PORT` | WebSocket server port | `8080` |
| `MQTT_HOST` | MQTT broker hostname | `mqtt.meshtastic.org` |
| `MQTT_PORT` | MQTT broker port | `1883` |
| `MQTT_USERNAME` | MQTT auth username | `meshdev` |
| `MQTT_PASSWORD` | MQTT auth password | `large4cats` |
| `MQTT_ROOT` | Base topic prefix | `msh` |
| `MQTT_REGION` | LoRa region | `EU_868` |
| `MQTT_PATH` | Protocol path (`2/e` for protobuf, `2/json` for JSON) | `2/e` |
| `DEFAULT_CHANNEL` | Default channel name | `LongFast` |
| `DEFAULT_KEY` | Default PSK (see [PSK Shorthand](#psk-shorthand-expansion) below) | `AQ==` |
| `GATEWAY_ID` | Node ID used as sender for outbound packets (user-specific) | `!ffffffff` |
| `CHANNEL_KEYS` | Per-channel PSK map for server-side multi-key decryption (optional) | — |

**`CHANNEL_KEYS` format** (parsed by `config.js`):
- JSON object: `CHANNEL_KEYS={"LongFast":"AQ==","MyPrivate":"base64key..."}`
- CSV fallback: `CHANNEL_KEYS=LongFast:AQ==,MyPrivate:base64key...`
- If omitted, only `DEFAULT_CHANNEL` + `DEFAULT_KEY` are used for decryption.
- At runtime, outbound publishes also register their channel/key pair into an in-memory cache for decryption.

## Development
```bash
npm install
npm start       # Production
npm run dev     # Development with auto-reload
```

---

## Message Structure

### Complete Protobuf Hierarchy
```
ServiceEnvelope (MQTT wrapper)
├── packet: MeshPacket
│   ├── from: fixed32 (sender node ID, e.g., 0xd844b556)
│   ├── to: fixed32 (receiver, 0xFFFFFFFF = broadcast)
│   ├── id: fixed32 (random packet ID)
│   ├── channel: varint (XOR hash of channel name + key)
│   ├── hopLimit: varint (0 for public MQTT, 3 for private)
│   ├── hopStart: varint (0 for public MQTT, 3 for private)
│   ├── wantAck: bool (request acknowledgment)
│   ├── viaMqtt: bool (true for MQTT-originated messages)
│   └── encrypted: bytes (AES-CTR encrypted Data)
│       └── Data (after decryption)
│           ├── portnum: varint (1 = TEXT_MESSAGE_APP)
│           ├── payload: bytes (UTF-8 message text)
│           └── bitfield: varint (capabilities, usually 1)
├── channel_id: string ("LongFast")
└── gateway_id: string ("!d844b556")
```

### Wire Types (Protobuf)
- `0` - VARINT: Variable-length integers
- `1` - FIXED64: 8 bytes, little-endian
- `2` - LENGTH_DELIMITED: Length prefix + data
- `5` - FIXED32: 4 bytes, little-endian

---

## Encryption Details

### Algorithm
- AES-128-CTR for 16-byte keys
- AES-256-CTR for 32-byte keys
- Only key lengths of 0 (no crypto), 1 (shorthand), 16, or 32 bytes are accepted

### Nonce Structure (16 bytes)
```
Bytes 0-3:   packetId (uint32 little-endian)
Bytes 4-7:   zeros
Bytes 8-11:  fromNode (uint32 little-endian)
Bytes 12-15: zeros
```

### PSK Shorthand Expansion

The Meshtastic channel `psk` protobuf field accepts 0, 1, 16, or 32 bytes. A **1-byte value** is not a literal key — it's a shorthand index that the firmware (and our `crypto.js`) expands into a full 16-byte AES key.

**Hard-coded default key** (from `Channels.h` in firmware):
```
Hex:    d4 f1 bb 3a 20 29 07 59 f0 bc ff ab cf 4e 69 01
Base64: 1PG7OiApB1nwvP+rz05pAQ==
```

**Expansion rules** (implemented in `expandMeshtasticPsk` in `crypto.js`):

| PSK bytes | Meaning | Resulting AES key |
|-----------|---------|-------------------|
| 0 bytes | No encryption | — |
| 1 byte `0x00` | No encryption | — |
| 1 byte `0x01` (`AQ==`) | Default key | `d4f1...6901` (last byte = `01`) |
| 1 byte `0x02` (`Ag==`) | "Simple 1" | `d4f1...6902` (last byte = `02`) |
| 1 byte `0x03` (`Aw==`) | "Simple 2" | `d4f1...6903` (last byte = `03`) |
| 1 byte `0xNN` | "Simple N-1" | Default key with last byte = `NN` |
| 16 bytes | AES-128 key | Used as-is |
| 32 bytes | AES-256 key | Used as-is |

The shorthand simply replaces the last byte of the default key with the index value. For index `0x01` this is a no-op (the default key already ends in `01`). Both `AQ==` and `1PG7OiApB1nwvP+rz05pAQ==` resolve to identical key bytes.

**Security note:** The default and "simple" keys are publicly known (hard-coded in firmware source). They provide protocol separation, not confidentiality. For private channels, use a randomly generated 16 or 32-byte key.

Source: https://github.com/meshtastic/firmware/blob/master/src/mesh/CryptoEngine.cpp

### Zero-Hop Policy (Public MQTT)
The public MQTT server (`mqtt.meshtastic.org`) enforces a **zero-hop policy**:
- Messages must have `hop_limit = 0` and `hop_start = 0`
- Traffic only reaches directly connected nodes, not the wider mesh
- Prevents MQTT traffic from flooding local mesh networks
- Private MQTT brokers can use `hop_limit = 3` for mesh propagation
- Source: https://meshtastic.org/docs/software/integrations/mqtt/

**Routing implications:**
- If the target node is **MQTT-connected** (a gateway), it can receive messages globally
- If the target is **LoRa-only**, it must be within **direct RF range** of a gateway
- Multi-hop LoRa propagation does NOT work with public MQTT traffic

### Channel Hash
The `channel` field in MeshPacket is NOT the channel index — it's an XOR hash:
```javascript
channelHash = xorAllBytes(channelName) ^ xorAllBytes(expandedKeyBytes)
```
This allows receivers to identify which key to use for decryption.

**Important:** The hash uses the *expanded* key bytes (after shorthand expansion), not the raw PSK config bytes. So `AQ==` and `1PG7OiApB1nwvP+rz05pAQ==` produce the same channel hash for a given channel name.

---

## Message Flow

### Sending (Browser → Mesh)
1. Browser: User fills form (gateway, receiver, channel, message, key)
2. Browser: Sends WebSocket `{ type: 'publish', ... }`
3. Server: Parses node IDs (hex to uint32)
4. Server: Generates random 32-bit packet ID
5. Server: Computes channel hash (channel name XOR key)
6. Server: Encodes Data message (portnum + payload + bitfield)
7. Server: Encrypts Data with AES-CTR (nonce from packetId + fromNode)
8. Server: Wraps in MeshPacket (from, to, id, channel, hopLimit, hopStart, viaMqtt, encrypted)
9. Server: Wraps in ServiceEnvelope (packet, channelId, gatewayId)
10. Server: Publishes binary protobuf to MQTT topic
11. Server: Sends confirmation to browser via WebSocket

### Receiving (Mesh → Browser)
1. Server: Receives binary MQTT message
2. Server: Decodes ServiceEnvelope → MeshPacket
3. Server: Builds decryption key candidates from `CHANNEL_KEYS`, runtime cache, and default key
4. Server: Filters candidates by channel hash match (if available)
5. Server: Tries each candidate key — first successful `decodeData` wins
6. Server: If portnum=1, extracts UTF-8 text
7. Server: Broadcasts to all WebSocket clients with metadata
8. Browser: Displays in activity log with decryption status

---

## MQTT Gateway Concepts

### Mental Model
MQTT is a **transport between gateways**, not "magic LoRa range extension." When MQTT is enabled, a Meshtastic gateway **uplinks/downlinks raw protobuf MeshPackets** to an MQTT broker (wrapped in a ServiceEnvelope).

### Cross-Region Communication (e.g., Germany ↔ Romania)
1. A **gateway in Germany** hears a message over LoRa (or originates it)
2. That gateway **publishes** it to MQTT (if channel has **Uplink enabled**)
3. A **gateway in Romania** subscribed to the same channel/root **receives** it from MQTT (if **Downlink enabled**)
4. The Romanian gateway **injects it into its local LoRa mesh**

### Device Requirements (Public Broker)
| Scenario | Min Devices | Notes |
|----------|-------------|-------|
| Both targets are MQTT-connected | 2 | Each node is a gateway |
| One target is LoRa-only | 3 | Gateway + Gateway + LoRa node |

With public broker zero-hop, LoRa-only targets must be within **direct RF range** of a gateway.

---

## MQTT Topic Structure

### Two Topic Families per Channel

**Protobuf topic (binary):**
```
msh/REGION/2/e/CHANNELNAME/USERID
```
Example: `msh/EU_868/2/e/LongFast/!b2a73a2c`
- Payload is raw protobuf (appears as "garbage" in text tools)
- This is what this project publishes/subscribes to

**JSON topic (readable):**
```
msh/REGION/2/json/CHANNELNAME/USERID
```
- Human-readable JSON format
- Only available if device has **JSON Enabled** in MQTT settings
- JSON packets are **NOT encrypted** (plaintext on broker)

### Root Topic Namespacing
- Default root: `msh/REGION` (e.g., `msh/EU_868`)
- Custom root creates separate namespace (e.g., `msh/EU_868/Bavaria`)
- For cross-region bridging, **both gateways must use the same root topic**

---

## Channel Uplink/Downlink Settings

Each channel on a Meshtastic device has two MQTT "bridge switches":

| Setting | Effect |
|---------|--------|
| **Uplink Enabled** | Gateway publishes LoRa messages it hears to MQTT |
| **Downlink Enabled** | Gateway subscribes to MQTT and injects messages into LoRa |

**Both must be enabled** on gateways at each end for bidirectional bridging.

### Related LoRa Settings
| Setting | Effect |
|---------|--------|
| **Ignore MQTT** | If true, device ignores MQTT-injected traffic |
| **OK to MQTT** | Polite flag indicating you consent to your traffic being forwarded |

---

## MQTT vs Channel Encryption

Two **separate** encryption settings exist:

### 1. Channel PSK (LoRa encryption)
- Each channel has a Pre-Shared Key
- Default primary channel uses `AQ==` (byte 0x01)
- Encrypts the Data payload within MeshPacket

### 2. MQTT Module "Encryption Enabled"
- Controls whether packets are sent to broker encrypted or unencrypted
- If **OFF**: packets sent to broker **unencrypted** even if channel has PSK
- If **ON**: payload remains encrypted with channel key
- The `/e/` topic can contain either encrypted or unencrypted protobuf depending on this setting

---

## Sending Messages via MQTT

### Option A: JSON Downlink (Easy, Unencrypted)
Publish JSON to: `msh/REGION/2/json/mqtt/`

Requires:
1. Create a channel named **`mqtt`** on the gateway
2. Enable **Downlink** on that channel
3. Reboot the device

The JSON message instructs the gateway to transmit onto the mesh.
**Note:** JSON payloads are **not encrypted** on the broker.

### Option B: Raw Protobuf (This Project)
Publish valid ServiceEnvelope protobuf to: `msh/REGION/2/e/CHANNELNAME/GATEWAYID`

Requires:
1. Build valid Meshtastic protobuf (ServiceEnvelope → MeshPacket → Data)
2. Handle encryption correctly if channel uses PSK
3. Set correct hopLimit (0 for public broker)

This is what this web client implements.

---

## Node ID Format
- Internal: 32-bit unsigned integer (e.g., `3628782934`)
- Display: Hex with prefix (e.g., `!d844b556`)
- Broadcast: `0xFFFFFFFF` displayed as `^all`

### Parsing Rules
```javascript
"!d844b556"  → parseInt("d844b556", 16)  → 3628782934
"0xd844b556" → parseInt("d844b556", 16)  → 3628782934
"^all"       → 0xFFFFFFFF                → 4294967295
"3628782934" → parseInt("3628782934", 10) → 3628782934
```

---

## PortNum Values
| Value | Name | Description |
|-------|------|-------------|
| 0 | UNKNOWN_APP | Unknown |
| 1 | TEXT_MESSAGE_APP | Text messages |
| 3 | POSITION_APP | GPS position |
| 4 | NODEINFO_APP | Node information |
| 5 | ROUTING_APP | Routing/ACK |
| 6 | ADMIN_APP | Admin commands |
| 67 | TELEMETRY_APP | Sensor telemetry |
| 70 | TRACEROUTE_APP | Trace route |
| 73 | MAP_REPORT_APP | Map reports |

---

## WebSocket Message Types

### Client → Server
| Type | Fields | Description |
|------|--------|-------------|
| `publish` | channel, gatewayId, to, text, key | Send message to mesh |
| `subscribe` | topic | Subscribe to MQTT topic |

### Server → Client
| Type | Fields | Description |
|------|--------|-------------|
| `status` | connected | MQTT connection state |
| `message` | topic, from, to, text, portnum, decryptionStatus, ... | Decoded message |
| `raw_message` | topic, payload, size | Failed to decode |
| `published` | topic, packetId, from, to, text | Confirm sent |
| `error` | message | Error notification |

---

## Key Files Reference

### crypto.js
- `decodeMeshtasticKey(keyBase64)` - Base64-decode + PSK shorthand expansion → AES key bytes
- `generateChannelHash(channelName, keyBase64)` - XOR hash for channel field (uses expanded key)
- `encrypt(plaintext, keyBase64, packetId, fromNode)` - AES-CTR encrypt
- `decrypt(ciphertext, keyBase64, packetId, fromNode)` - AES-CTR decrypt
- `generatePacketId()` - Random 32-bit packet ID

### protobuf.js
- `encodeData({ portnum, payload, bitfield })` - Encode Data message
- `decodeData(buffer)` - Decode Data message
- `encodeMeshPacket({ from, to, id, channel, hopLimit, hopStart, viaMqtt, encrypted })` - Encode packet
- `decodeMeshPacket(buffer)` - Decode packet
- `encodeServiceEnvelope({ packet, channelId, gatewayId })` - Encode envelope
- `decodeServiceEnvelope(buffer)` - Decode envelope
- `parseNodeId(str)` - Parse "!hex" or decimal to uint32
- `formatNodeId(num)` - Format uint32 to "!hex"
