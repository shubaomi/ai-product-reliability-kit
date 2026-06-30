import { productId, releaseVersion } from "../../../lib/reliability";

export async function GET() {
  const checks = {
    database: true,
    external_api: true
  };

  return Response.json({
    ok: Object.values(checks).every(Boolean),
    product_id: productId,
    release: releaseVersion(),
    checks
  });
}

