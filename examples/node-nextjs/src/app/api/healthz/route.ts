import { productId, releaseVersion } from "../../../lib/reliability";

export function GET() {
  return Response.json({
    ok: true,
    product_id: productId,
    environment: process.env.NODE_ENV ?? "development",
    release: releaseVersion(),
    time: new Date().toISOString()
  });
}

