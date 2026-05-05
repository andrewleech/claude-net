FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src/
COPY bin/ ./bin/
# Pre-build the mirror-agent bundle so /bin/mirror-agent.bundle.js is
# served instantly. The hub would build it lazily otherwise, which works
# but takes ~10ms on the first hit.
RUN bun build --target=bun ./src/mirror-agent/agent.ts \
    --outfile ./bin/mirror-agent.bundle.js
ARG GIT_COMMIT=dev
ENV CLAUDE_NET_VERSION=$GIT_COMMIT
ENV CLAUDE_NET_PORT=4815
EXPOSE 4815
CMD ["bun", "run", "src/hub/index.ts"]
