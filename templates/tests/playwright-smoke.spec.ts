import { test, expect } from "@playwright/test";

test("production health check responds", async ({ request }) => {
  const baseURL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
  const response = await request.get(`${baseURL}/healthz`);

  expect(response.ok()).toBeTruthy();
  expect(response.status()).toBe(200);
});
