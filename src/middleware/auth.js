import { User } from "../models/User.js";
import { verifyToken } from "../services/tokens.js";

const bearerToken = (req) => {
  const authHeader = req.headers["authorization"];
  return authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
};

// Accepts both website session tokens and API tokens; `req.tokenKind` says which it was.
export const authenticateToken = async (req, res, next) => {
  const token = bearerToken(req);

  if (!token) {
    return res.status(401).json({ error: "Access denied. Token missing." });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token: " + err.message });
  }

  try {
    const user = decoded && decoded.id ? await User.findById(decoded.id).select("-passwordHash") : null;
    if (!user) {
      return res.status(401).json({ error: "Invalid authentication token or user not found." });
    }
    // Regenerating the API token bumps the version, which retires every earlier one.
    if (decoded.kind === "api" && (decoded.v || 0) !== (user.apiTokenVersion || 0)) {
      return res.status(401).json({
        error: "This API token was regenerated and no longer works. Copy the new one from your profile."
      });
    }
    req.user = user;
    req.tokenKind = decoded.kind === "api" ? "api" : "session";
    return next();
  } catch (err) {
    return next(err);
  }
};

// No token means a guest. A token that doesn't check out is an error rather than a guest:
// quietly treating it as one would publish the package without its owner.
export const optionalAuthenticateToken = (req, res, next) =>
  bearerToken(req) ? authenticateToken(req, res, next) : next();
