import { withStoreLock } from "./repository.js";
// Commit mutations before sending a successful response to the tablet.
export function transactionalRoutes(app) {
  const routes = {};
  for (const method of ["get", "post", "put", "delete"]) {
    routes[method] = (route, ...handlers) => {
      const handler = handlers.pop();
      return app[method](route, ...handlers, async (req, res, next) => {
        const json = res.json.bind(res);
        let payload,
          responded = false;
        res.json = (value) => {
          payload = value;
          responded = true;
          return res;
        };
        try {
          await withStoreLock(() => handler(req, res, next));
          res.json = json;
          if (responded) json(payload);
        } catch (error) {
          res.json = json;
          next(error);
        }
      });
    };
  }
  return routes;
}
