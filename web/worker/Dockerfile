FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip install --no-cache-dir --break-system-packages pdfplumber \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc -p worker/tsconfig.worker.json
RUN npm prune --omit=dev
CMD ["node", "worker/dist/worker/index.js"]
