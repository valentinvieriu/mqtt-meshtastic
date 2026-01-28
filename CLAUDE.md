# MQTT-Meshtastic

## Project Overview
A web client for sending encrypted messages to Meshtastic devices via the public MQTT broker at mqtt.meshtastic.org. Uses proper Meshtastic protobuf message format.

## Tech Stack
- Node.js (ES Modules)
- mqtt.js (MQTT client)
- ws (WebSocket for browser communication)
- Native crypto (AES256-CTR encryption)
- Custom protobuf encoder/decoder (no external dependency)

## Key Concepts
- **Meshtastic**: Open-source mesh networking for LoRa radios
- **MQTT**: Lightweight messaging protocol
- **Protobuf**: Binary serialization format used by Meshtastic
- **AES256-CTR**: Encryption (default key: AQ== / 0x01)

## Message Structure
```
ServiceEnvelope (MQTT wrapper)
├── packet: MeshPacket
│   ├── from: uint32 (sender node ID)
│   ├── to: uint32 (receiver, 0xFFFFFFFF = broadcast)
│   ├── id: uint32 (packet ID)
│   ├── channel: uint32 (channel index)
│   ├── hopLimit: uint32 (default 3)
│   └── encrypted: bytes (AES-CTR encrypted Data)
│       └── Data
│           ├── portnum: 1 (TEXT_MESSAGE_APP)
│           └── payload: bytes (UTF-8 text)
├── channel_id: "LongFast"
└── gateway_id: "!xxxxxxxx"
```

## Project Structure
```
src/
├── server/
│   ├── index.js          # Main entry, WebSocket + MQTT bridge
│   ├── config.js         # Environment configuration
│   ├── crypto.js         # AES256-CTR encryption/decryption
│   ├── protobuf.js       # Meshtastic protobuf encode/decode
│   ├── http-server.js    # Static file serving + API
│   └── mqtt-client.js    # MQTT client for mqtt.meshtastic.org
└── public/
    ├── index.html
    ├── css/styles.css
    └── js/
        ├── app.js            # Main app entry
        ├── ws-client.js      # WebSocket client
        ├── message-builder.js # Topic/ID utilities
        └── ui.js             # DOM utilities
```

## Configuration (.env)
```
PORT=3000
WS_PORT=8080
MQTT_HOST=mqtt.meshtastic.org
MQTT_PORT=1883
MQTT_USERNAME=meshdev
MQTT_PASSWORD=large4cats
MQTT_ROOT_TOPIC=msh/EU_868/2/e
DEFAULT_CHANNEL=LongFast
DEFAULT_KEY=AQ==
GATEWAY_ID=!d844b556
```

## Development
```bash
npm install
npm start       # Production
npm run dev     # Development with auto-reload
```

## Encryption Details
- Algorithm: AES-128-CTR (for keys <= 16 bytes) or AES-256-CTR
- Nonce (16 bytes): packetId (4 LE + 4 zeros) + fromNode (4 LE + 4 zeros)
- Default LongFast key: `1PG7OiApB1nwvP+rz05pAQ==` (expanded from AQ==)
- Source: https://github.com/meshtastic/firmware/blob/master/src/mesh/CryptoEngine.cpp

## PortNum Values
- 0: UNKNOWN_APP
- 1: TEXT_MESSAGE_APP
- 3: POSITION_APP
- 4: NODEINFO_APP
- 5: ROUTING_APP
- 67: TELEMETRY_APP
