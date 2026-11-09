import test from "node:test";
import assert from "node:assert/strict";
import {
  authSessionCookie,
  issueAuthToken,
  parseCookies,
  verifyAuthToken,
} from "../api/_lib/authToken.js";

process.env.JWT_SECRET = "auth-token-test-secret";

test("issues and verifies a role-aware manager token", () => {
  const token = issueAuthToken({ id: "507f1f77bcf86cd799439011", role: "manager", email: "manager@example.com" }, 1_700_000_000_000);
  const claims = verifyAuthToken(token, 1_700_000_001_000);

  assert.equal(claims?.userId, "507f1f77bcf86cd799439011");
  assert.equal(claims?.role, "manager");
  assert.equal(claims?.email, "manager@example.com");
});

test("rejects a tampered or expired token", () => {
  const token = issueAuthToken({ id: "507f1f77bcf86cd799439011", role: "employee" }, 1_700_000_000_000);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  assert.equal(verifyAuthToken(tampered, 1_700_000_001_000), null);
  assert.equal(verifyAuthToken(token, 1_700_604_801_000), null);
});

test("serializes the HttpOnly auth cookie with the expected scope", () => {
  const cookie = authSessionCookie("signed-token", false);
  const cookies = parseCookies(cookie);

  assert.equal(cookies.xm_auth_session, "signed-token");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});
