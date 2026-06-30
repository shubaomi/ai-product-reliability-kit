FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY apps/dashboard/package*.json ./
RUN npm ci --omit=dev

COPY apps/dashboard/ ./

EXPOSE 8787
CMD ["node", "server.mjs"]
