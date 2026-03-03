FROM python:3.11-slim AS python-deps
RUN pip install --no-cache-dir --target=/python-packages pdfplumber

FROM node:20-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=python-deps /python-packages /usr/lib/python3/dist-packages/
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc -p worker/tsconfig.worker.json
RUN npm prune --omit=dev
CMD ["node", "worker/dist/worker/index.js"]
