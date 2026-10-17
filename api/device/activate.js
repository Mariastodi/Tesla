// Explicit Vercel entrypoint for the tablet activation endpoint.
// The Express app owns validation, rate limiting, and the signed device cookie.
import app from "../../server.js";

export default app;
