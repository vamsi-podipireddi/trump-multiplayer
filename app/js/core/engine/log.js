function name(G, p) { return (G.names && G.names[p]) || ["South","West","North","East"][p]; }
function logG(G, text, cls) { if (G._silent) return; G.log.push({ text, cls: cls || "" }); if (G.log.length > 80) G.log.shift(); }

export { logG, name };
