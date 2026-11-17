// intelbrew.sh Worker entry point. The logic lives in ./routes.js; this module
// must export only the handler (workerd treats named exports as entrypoints).
import { handle } from "./routes.js";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
