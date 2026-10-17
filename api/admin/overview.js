// Explicit Vercel entrypoint for the coordination panel login/bootstrap.
// The Express route validates the x-admin-pin header and returns the dashboard data.
import app from "../../server.js";

export default app;
