FROM node:22-bookworm-slim

# Install system dependencies: ffmpeg, curl, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install go2rtc binary for Linux AMD64
RUN curl -L -s https://github.com/AlexxIT/go2rtc/releases/download/v1.9.8/go2rtc_linux_amd64 -o /usr/local/bin/go2rtc \
    && chmod +x /usr/local/bin/go2rtc

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy project source code
COPY . .

# Ensure storage and data directories exist
RUN mkdir -p data downloads bin

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
EXPOSE 1984

CMD ["node", "server.js"]

