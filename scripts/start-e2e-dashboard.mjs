import { promises as fs } from "node:fs";
import process from "node:process";
import { createDashboardServer } from "../apps/dashboard/server.mjs";

if (process.env.APR_DASHBOARD_STORE) {
  await fs.rm(process.env.APR_DASHBOARD_STORE, { force: true });
  await fs.rm(`${process.env.APR_DASHBOARD_STORE}.tmp`, { force: true });
}

const server = await createDashboardServer();
await new Promise((resolve) => server.listen(
  Number(process.env.PORT ?? 8787),
  process.env.HOST ?? "127.0.0.1",
  resolve
));

console.log(`E2E Dashboard listening on http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8787}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.shutdown();
    process.exit(0);
  });
}
