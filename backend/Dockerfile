
FROM node:22-bookworm-slim

WORKDIR /app

# Install build tools required by better-sqlite3
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install backend dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
