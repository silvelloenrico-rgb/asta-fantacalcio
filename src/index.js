export { League } from './league.js';

// Single league instance: every API call and websocket goes to the same Durable Object,
// which serialises all bids/trades so they can never overlap.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const stub = env.LEAGUE.get(env.LEAGUE.idFromName('cfp'));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
