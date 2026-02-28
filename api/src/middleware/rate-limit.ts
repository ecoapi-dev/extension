import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { AppError } from "../utils/app-error";

const SCAN_LIMIT = 10;       // max scans per window
const WINDOW_SECONDS = 60;   // rolling window in seconds

// Rate limits POST /projects/:id/scans to SCAN_LIMIT requests per WINDOW_SECONDS per project.
// Uses Cloudflare KV as the counter store (eventual consistency is acceptable here).
export const scanRateLimitMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const projectId = c.req.param("id");
  if (!projectId) return next();

  const key = `rl:scan:${projectId}`;
  const raw = await c.env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= SCAN_LIMIT) {
    throw new AppError(
      "RATE_LIMITED",
      `Scan limit of ${SCAN_LIMIT} per ${WINDOW_SECONDS}s exceeded for this project.`,
      429
    );
  }

  // Increment; only set TTL on first write so the window is fixed from first request
  await c.env.KV.put(key, String(count + 1), raw ? undefined : { expirationTtl: WINDOW_SECONDS });

  return next();
};
