FROM node:22-alpine

WORKDIR /workspace
ENV NODE_ENV=production

COPY standard/ ./standard/
RUN cd standard && npm ci --omit=dev

COPY apps/dashboard/package*.json ./apps/dashboard/
RUN cd apps/dashboard && npm ci --omit=dev

COPY apps/dashboard/ ./apps/dashboard/
WORKDIR /workspace/apps/dashboard

EXPOSE 8787
CMD ["node", "server.mjs"]
