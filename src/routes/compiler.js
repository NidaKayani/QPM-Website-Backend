import express from "express";
import { listCompilerFiles, downloadCompilerFile } from "../services/googleDrive.js";

/**
 * Quantum compiler releases, for `quantum update` (qpm self-update).
 *
 * The release lives in a Google Drive folder (GOOGLE_DRIVE_COMPILER_FOLDER_ID):
 * the build's files plus version.sa, whose text is the version ("3.0.0").
 *
 *   GET /api/compiler/version          { version, files: [{ name, size }] }
 *   GET /api/compiler/download/:file   the file's bytes
 */
const router = express.Router();

const VERSION_FILE = "version.sa";
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { at, version, files: [{ id, name, size }] }

async function release() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const files = await listCompilerFiles();
  const versionFile = files.find((f) => f.name === VERSION_FILE);
  if (!versionFile) {
    const error = new Error("No compiler release is published yet (version.sa is missing from the release folder).");
    error.status = 404;
    throw error;
  }
  const version = (await downloadCompilerFile(versionFile.id)).toString("utf8").trim();
  cache = { at: Date.now(), version, files: files.filter((f) => f.name !== VERSION_FILE) };
  return cache;
}

router.get("/version", async (req, res) => {
  try {
    const r = await release();
    res.setHeader("Cache-Control", "no-store");
    res.json({ version: r.version, files: r.files.map(({ name, size }) => ({ name, size })) });
  } catch (err) {
    console.error("Compiler release lookup failed:", err);
    res.status(err.status || 500).json({ error: err.message || "Failed to read the compiler release" });
  }
});

router.get("/download/:file", async (req, res) => {
  try {
    const r = await release();
    // only a file of the release, by its exact name: nothing else on Drive or disk is reachable
    const file = r.files.find((f) => f.name === req.params.file);
    if (!file) {
      return res.status(404).json({ error: `${req.params.file} is not part of the compiler release` });
    }
    const bytes = await downloadCompilerFile(file.id);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Content-Length", bytes.length.toString());
    res.setHeader("X-Quantum-Version", r.version);
    return res.status(200).send(bytes);
  } catch (err) {
    console.error("Compiler download failed:", err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to download the compiler" });
  }
});

export default router;
