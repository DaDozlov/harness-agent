# heaw in a container (docs/DESIGN.md §4.12).
#
#   docker build -t heaw .
#   docker run -it --rm -v "$PWD:/workspace" --env-file .env heaw
#
# The project is mounted at /workspace; the agent can change only what is mounted.

# Development: the dev container (.devcontainer/) builds this stage.
FROM node:24-bookworm AS dev
# The full Node image already has git and curl.
USER node
WORKDIR /workspaces/harness-agent

# Build: compile with the dev dependencies, then drop them.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: the default target.
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
RUN chmod +x dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/heaw
# Not root: files the agent writes into a mounted project belong to an ordinary user (uid 1000).
USER node
RUN git config --global --add safe.directory /workspace
WORKDIR /workspace
ENTRYPOINT ["heaw"]
