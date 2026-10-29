import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, dbStatus } from "./src/config/db.js";
import authRouter from "./src/routes/auth.js";
import registryRouter from "./src/routes/registry.js";
import compilerRouter from "./src/routes/compiler.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB (failures are logged and retried per request below)
connectDB().catch(() => {});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Health Check
app.get("/api/health", async (req, res) => {
  await connectDB().catch(() => {});
  res.json({
    status: "ok",
    service: "QPM Registry Backend",
    database: { engine: "MongoDB", ...dbStatus() },
    storage: "Google Drive API",
    timestamp: new Date().toISOString()
  });
});

// Compiler releases (`quantum update`): Google Drive only, no database needed
app.use("/api/compiler", compilerRouter);

// Every other API route needs the database; answer fast instead of buffering queries.
app.use("/api", (req, res, next) => {
  connectDB().then(
    () => next(),
    () => res.status(503).json({ error: "The registry database is unavailable. Please try again shortly." })
  );
});

// API Routes
app.use("/api/auth", authRouter);
app.use("/api/registry", registryRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Server Error:", err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`🚀 QPM Backend Server running on http://localhost:${PORT}`);
  console.log(`📦 Registry API available at http://localhost:${PORT}/api/registry`);
  console.log(`🔑 Auth API available at http://localhost:${PORT}/api/auth`);
});
