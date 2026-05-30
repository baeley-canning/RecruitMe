FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++  # better-sqlite3 native build
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=3000 DB_PATH=/data/portal.sqlite
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.mjs"]
