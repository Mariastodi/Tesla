import { pool, transaction, repositoryReady } from "./repository.js";
let localQueue = Promise.resolve();
// Every API read-modify-write is isolated, including across server instances.
export function transactionalRoutes(app) {
  const routes = {};
  for (const method of ["get", "post", "put", "delete"]) {
    const register = app[method].bind(app);
    routes[method] = (route, ...handlers) => {
      if (!handlers.length) return register(route);
      const handler = handlers.pop();
      return register(route, ...handlers, (req, res, next) => {
        const execute = async () => {
          let client;
          const originalJson = res.json.bind(res);
          try {
            await repositoryReady;
            if (pool && String(route).startsWith("/api/")) {
              client = await pool.connect();
              await client.query("BEGIN");
              await client.query("SELECT pg_advisory_xact_lock(74823901)");
            }
            // Delay JSON responses until the transaction is committed.
            const json = res.json.bind(res);
            let payload;
            let responded = false;
            res.json = (value) => {
              payload = value;
              responded = true;
              return res;
            };
            await transaction.run(client, () => handler(req, res, next));
            if (client) await client.query("COMMIT");
            res.json = json;
            if (responded) json(payload);
          } catch (error) {
            if (client) await client.query("ROLLBACK").catch(() => {});
            res.json = originalJson;
            next(error);
          } finally {
            client?.release();
          }
        };
        if (pool) execute();
        else {
          localQueue = localQueue.then(execute, execute);
        }
      });
    };
  }

  return routes;
}
