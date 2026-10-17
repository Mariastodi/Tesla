// Explicit Vercel entrypoint for coordination panel API routes.
// Express keeps ownership of authentication, validation, and database access.
import app from "../../server.js";

export default app;
