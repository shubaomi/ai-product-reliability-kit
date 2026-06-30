export const productId = "reliable-nextjs-example";

export function releaseVersion() {
  return process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";
}

export function captureError(error: unknown, context: Record<string, unknown> = {}) {
  // Replace with Sentry.captureException(error, { tags: context }) in production.
  console.error("capture_error", {
    product_id: productId,
    release: releaseVersion(),
    ...context,
    error
  });
}

export function trackEvent(event: string, properties: Record<string, unknown> = {}) {
  // Replace with PostHog/analytics.track/capture in production.
  console.info("trackEvent", {
    product_id: productId,
    release: releaseVersion(),
    event,
    properties
  });
}

