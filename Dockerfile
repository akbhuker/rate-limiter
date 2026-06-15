# Single-stage image that runs the example gateway (incl. the demo dashboard).
# We run the TypeScript entrypoint directly with tsx — no separate build/copy
# dance, and the Lua scripts under src/core/lua are read at runtime.
FROM node:22-alpine
WORKDIR /app

# Install all deps (tsx + ioredis + express/fastify) BEFORE flipping NODE_ENV,
# so dev deps like tsx are present.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Most hosts inject PORT; config.ts reads it. Express binds 0.0.0.0 by default.
CMD ["npx", "tsx", "examples/express-server.ts"]
