import jwt from "jsonwebtoken";

const secret = () => process.env.JWT_SECRET || "quantum_package_manager_super_secret_jwt_key_2026";

/** A website sign-in session. Expires after 7 days. */
export const signSessionToken = (user) =>
  jwt.sign({ id: user._id, username: user.username, email: user.email }, secret(), { expiresIn: "7d" });

/**
 * The account's API token, for `qpm login` and scripts. It never expires, and since it's
 * signed without a timestamp it stays the same string until the user regenerates it,
 * which bumps `apiTokenVersion` and so invalidates every earlier API token.
 */
export const signApiToken = (user) =>
  jwt.sign({ id: String(user._id), kind: "api", v: user.apiTokenVersion || 0 }, secret(), { noTimestamp: true });

/** The token's claims. Throws jsonwebtoken's errors for a forged or expired token. */
export const verifyToken = (token) => jwt.verify(token, secret());
