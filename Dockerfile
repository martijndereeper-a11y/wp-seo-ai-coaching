FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY src/ ./src/
COPY coaching-guides/ ./coaching-guides/
COPY api/ ./api/
COPY industries-data.json ./industries-data.json

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/api/server.ts"]
