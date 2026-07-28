function okOrigin(request, url, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // non-browser client
  try { if (new URL(origin).host === url.host) return true; } catch {}
  const allow = (env && env.ALLOW_ORIGIN ? String(env.ALLOW_ORIGIN) : "").split(",").map(s => s.trim()).filter(Boolean);
  return allow.includes(origin);
}

export { okOrigin };
