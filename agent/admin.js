"use strict";
const crypto = require("crypto");

// Constant-time token check. Accepts the `x-admin-token` header or a `token` field in a POST body.
// The URL query is deliberately NOT accepted: query strings end up in server logs and browser history.
function makeAdminCheck(token) {
  const want = crypto.createHash("sha256").update(String(token || "")).digest();
  return function isAdmin(req) {
    if (!token) return false;
    const got = req.headers["x-admin-token"] || (req.body && req.body.token) || "";
    const h = crypto.createHash("sha256").update(String(got)).digest();
    return crypto.timingSafeEqual(want, h);
  };
}

module.exports = { makeAdminCheck };
