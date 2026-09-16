FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm install --global npm@11.16.0 && npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG APP_VERSION=0.0.0-r08
ARG VCS_REF=uncommitted
ARG OCI_SOURCE=unset
LABEL org.opencontainers.image.title="SearchStax Zendesk Connector" \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
COPY package.json ./
COPY node ./node
COPY worker ./worker
COPY mysql-migrations ./mysql-migrations
COPY scripts/container.ts scripts/container-healthcheck.ts ./scripts/
RUN chmod -R a+rX mysql-migrations
USER node
EXPOSE 4173
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/container-healthcheck.ts"]
ENTRYPOINT ["node", "--experimental-transform-types", "scripts/container.ts"]
CMD ["start"]
