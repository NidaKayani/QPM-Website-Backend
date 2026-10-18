import dns from "node:dns";
import mongoose from "mongoose";

const STATES = ["disconnected", "connected", "connecting", "disconnecting"];

let pending = null;
let lastError = null;

/**
 * Connects once and reuses the connection. A failed attempt is not cached, so
 * the next request retries instead of every query buffering until it times out
 * (which is what happens on a long-lived serverless instance otherwise).
 */
export const connectDB = () => {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (pending) return pending;

  const connStr = process.env.MONGO_URI || (process.env.VERCEL ? "" : "mongodb://127.0.0.1:27017/qpm_registry");
  if (!connStr) {
    lastError = "MONGO_URI is not set.";
    console.error(`❌ MongoDB Connection Error: ${lastError}`);
    return Promise.reject(new Error(lastError));
  }
  console.log(`Connecting to MongoDB at ${connStr.replace(/:([^:@]+)@/, ":****@")} ...`);

  // Some local/ISP DNS resolvers refuse the SRV lookups that mongodb+srv:// needs
  // (querySrv ECONNREFUSED on Windows). Use public resolvers for those URIs.
  if (connStr.startsWith("mongodb+srv://") && !process.env.VERCEL) {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }

  // Fail well inside the serverless function timeout so the real error surfaces.
  pending = mongoose
    .connect(connStr, { serverSelectionTimeoutMS: 8000 })
    .then((m) => {
      lastError = null;
      console.log("✅ MongoDB Connected successfully!");
      return m.connection;
    })
    .catch((error) => {
      lastError = error.message;
      console.error("❌ MongoDB Connection Error:", error.message);
      throw error;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
};

export const dbStatus = () => {
  const state = STATES[mongoose.connection.readyState] ?? "unknown";
  return state === "connected" || !lastError ? { state } : { state, error: lastError };
};
