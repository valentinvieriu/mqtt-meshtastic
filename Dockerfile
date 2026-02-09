FROM node:25-alpine

LABEL maintainer="valentinvieriu"
LABEL description="Meshtastic MQTT web client with encrypted mesh messaging"

RUN apk add --no-cache tini

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src/ ./src/

ENV NODE_ENV=production \
    PORT=3000 \
    WS_PORT=8080

EXPOSE 3000 8080

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server/index.js"]
