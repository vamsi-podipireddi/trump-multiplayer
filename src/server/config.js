const PORT = process.env.PORT || 3000;
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MSG_RATE = 100, MAX_SOCKETS_PER_IP = 20, JOIN_GRACE_MS = 30000;
const DELAYS = {};
if (+process.env.AI_DELAY) DELAYS.ai = +process.env.AI_DELAY;
if (+process.env.TRICK_DELAY) DELAYS.trick = +process.env.TRICK_DELAY;
if (+process.env.ROUND_DELAY) DELAYS.round = +process.env.ROUND_DELAY;
const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
/* Off by default: X-Forwarded-For is caller-controlled, so trusting it without a
   proxy in front lets anyone forge their way past the per-IP cap. Set TRUST_PROXY=1
   when something upstream (nginx, Cloudflare, a tunnel) actually sets the header —
   otherwise every player behind it shares one socket budget. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}

export { PORT, MAX_ROOMS, MSG_RATE, MAX_SOCKETS_PER_IP, JOIN_GRACE_MS, DELAYS, ALLOW_ORIGIN, TRUST_PROXY, clientIp };
