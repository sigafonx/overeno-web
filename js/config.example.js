// ---------------------------------------------------------------------------
// Example PRODUCTION frontend config.
//
// This is a TEMPLATE, not loaded by any HTML page directly (only js/config.js
// is). To use it: copy this file's contents into js/config.js on your
// production server (overwriting the local-dev default), or have your
// deploy pipeline generate js/config.js from this template.
//
// Only the backend's public URL goes here. This is NOT a secret — it's
// already visible to anyone who opens their browser's dev tools on the
// live site. Never add API keys, passwords, or other real secrets here;
// this file is served as plain JavaScript to every visitor.
// ---------------------------------------------------------------------------
window.OVERENO_CONFIG = {
  // Replace with your real backend URL. Must match a domain that's also
  // listed in the backend's CORS_ORIGINS (see backend/.env.example) —
  // otherwise the browser will block every request with a CORS error.
  apiBaseUrl: 'https://api.nexium.cz'
};
