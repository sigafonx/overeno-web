// ---------------------------------------------------------------------------
// Runtime frontend configuration.
//
// Loaded as a plain <script> (NOT a JS module) before any module script
// that needs it, so `window.OVERENO_CONFIG` is guaranteed to already exist
// by the time js/api/api.js and the self-contained admin-*.js files run
// their top-level code.
//
// This is the ONE file to edit for a production deploy — no rebuild step,
// no touching js/api/api.js or any admin-*.js. Just change `apiBaseUrl`
// below to the backend's real public URL (e.g. "https://api.nexium.cz")
// and redeploy this single file. See js/config.example.js for a ready-made
// production template, and backend/README.md's "Frontend API base URL"
// section for the full how-to.
//
// Nothing in here is secret. `apiBaseUrl` is a public URL that's already
// visible to anyone who opens their browser's network tab on the live
// site — never put API keys, passwords, or any other real secret in this
// file, it ships to every visitor as plain, readable JavaScript.
// ---------------------------------------------------------------------------
window.OVERENO_CONFIG = {
  apiBaseUrl: 'http://localhost:3001'
};
