import { Hono } from "hono";
import type { AppContext } from "./env";
import { corsMiddleware } from "./middleware/cors";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestLoggingMiddleware } from "./middleware/logging";
import { requireJsonContentType } from "./middleware/content-type";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { scanRateLimitMiddleware } from "./middleware/rate-limit";
import healthRoutes from "./routes/health";
import projectRoutes from "./routes/projects";
import providerRoutes from "./routes/providers";
import chatRoutes from "./routes/chat";

const app = new Hono<AppContext>();

app.use("*", corsMiddleware);
app.use("*", requestIdMiddleware);
app.use("*", requestLoggingMiddleware);
app.use("*", requireJsonContentType);
app.post("/projects/:id/scans", scanRateLimitMiddleware);

app.get("/", (c) =>
  c.json({
    data: {
      name: "API Usage Analyzer",
      message: "API is running.",
      resources: ["/health", "/projects", "/providers"]
    }
  })
);

app.route("/", healthRoutes);
app.route("/", projectRoutes);
app.route("/", providerRoutes);
app.route("/", chatRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);

export default app;
