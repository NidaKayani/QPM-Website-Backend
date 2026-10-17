import { Router } from "express";
import multer from "multer";
import { Package } from "../models/Package.js";
import { PackageVersion } from "../models/PackageVersion.js";
import { DownloadStat } from "../models/DownloadStat.js";
import { uploadTarballToDrive, downloadTarballFromDrive, deleteTarballFromDrive } from "../services/googleDrive.js";
import { createTgz, cleanPath, extractTgz, isBinary, readPackageMeta } from "../services/tarball.js";
import { authenticateToken, optionalAuthenticateToken } from "../middleware/auth.js";

const router = Router();

// A version can be deleted and republished under the same number, and stats change
// constantly, so browsers must revalidate these (a 410 is even cacheable by default).
const noStore = (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache");
  next();
};
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB max, per file and for a whole package
const upload = multer({
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 5000, fieldSize: 5 * 1024 * 1024 }
});
const publishUpload = upload.fields([
  { name: "file", maxCount: 1 }, // a ready-made .tgz
  { name: "files", maxCount: 5000 } // loose files / a folder, packed into a .tgz here
]);

// GET /api/registry/search - Search packages
router.get("/search", async (req, res) => {
  try {
    const term = (req.query.q || "").toString().trim();
    let filter = {};

    if (term) {
      filter = {
        $or: [
          { name: { $regex: term, $options: "i" } },
          { description: { $regex: term, $options: "i" } },
          { keywords: { $regex: term, $options: "i" } }
        ]
      };
    }

    const packages = await Package.find(filter)
      .populate("owner", "username email")
      .sort({ downloads: -1, updatedAt: -1 })
      .limit(50);

    return res.json({
      objects: packages.map((p) => ({
        name: p.name,
        description: p.description,
        keywords: p.keywords,
        latest_version: p.latestVersion,
        downloads: p.downloads,
        updated_at: p.updatedAt,
        owner: p.owner ? p.owner.username : "anonymous"
      })),
      total: packages.length
    });
  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ error: err.message || "Failed to search packages." });
  }
});

// GET /api/registry/user/my-packages - Get packages owned by logged in user
router.get("/user/my-packages", authenticateToken, async (req, res) => {
  try {
    const packages = await Package.find({ owner: req.user._id })
      .sort({ updatedAt: -1 });
    return res.json({ packages });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch user packages." });
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (date) => date.toISOString().slice(0, 10);

// GET /api/registry/:name/stats - Download stats: last 52 weeks (oldest first) and last 7 days per version
router.get("/:name/stats", noStore, async (req, res) => {
  try {
    const pkg = await Package.findOne({ name: req.params.name.toLowerCase() });
    if (!pkg) {
      return res.status(404).json({ error: "Package not found." });
    }

    const WEEKS = 52;
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const start = today - (WEEKS * 7 - 1) * DAY_MS;
    const rows = await DownloadStat.find({ package: pkg._id, day: { $gte: utcDay(new Date(start)) } });

    const weekly = new Array(WEEKS).fill(0);
    const versions = {};
    const lastWeekStart = utcDay(new Date(today - 6 * DAY_MS));
    for (const { day, version, count } of rows) {
      const week = Math.floor((Date.parse(day) - start) / (7 * DAY_MS));
      if (week >= 0 && week < WEEKS) weekly[week] += count;
      if (day >= lastWeekStart) versions[version] = (versions[version] || 0) + count;
    }

    return res.json({ weekly, lastWeek: weekly[WEEKS - 1], versions });
  } catch (err) {
    console.error("Stats error:", err);
    return res.status(500).json({ error: err.message || "Failed to load download stats." });
  }
});

// GET /api/registry/:name/dependents - Packages whose latest version depends on this one
router.get("/:name/dependents", noStore, async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const candidates = await PackageVersion.find({ [`dependencies.${name}`]: { $exists: true } })
      .populate("package", "name latestVersion description");

    const dependents = candidates
      .filter((v) => v.package && v.package.latestVersion === v.version)
      .map((v) => ({
        name: v.package.name,
        version: v.version,
        description: v.package.description,
        range: v.dependencies.get(name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ dependents });
  } catch (err) {
    console.error("Dependents error:", err);
    return res.status(500).json({ error: err.message || "Failed to load dependents." });
  }
});

// GET /api/registry/:name - Get package metadata (QPM CLI & NPM compatible)
router.get("/:name", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const origin = `${req.protocol}://${req.get("host")}`;

    const pkg = await Package.findOne({ name }).populate("owner", "username email");
    if (!pkg) {
      return res.status(404).json({ error: `Package "${name}" not found.` });
    }

    const versions = await PackageVersion.find({ package: pkg._id }).sort({ createdAt: -1 });

    const versionMap = {};
    const timeMap = {};

    for (const v of versions) {
      versionMap[v.version] = {
        name: pkg.name,
        version: v.version,
        description: v.description,
        dependencies: Object.fromEntries(v.dependencies || new Map()),
        dist: {
          tarball: `${origin}/api/registry/${pkg.name}/-/${pkg.name}-${v.version}.tgz`,
          shasum: v.shasum || "verified",
          unpackedSize: v.file_size || 0
        }
      };
      timeMap[v.version] = v.createdAt;
    }

    return res.json({
      name: pkg.name,
      description: pkg.description,
      keywords: pkg.keywords,
      license: pkg.license,
      homepage: pkg.homepage,
      repository: pkg.repository,
      readme: pkg.readme,
      downloads: pkg.downloads || 0,
      owner: pkg.owner ? pkg.owner.username : "anonymous",
      "dist-tags": { latest: pkg.latestVersion },
      versions: versionMap,
      time: timeMap
    });
  } catch (err) {
    console.error("Fetch package error:", err);
    return res.status(500).json({ error: err.message || "Failed to fetch package details." });
  }
});

// GET /api/registry/:name/-/:file - Download tarball (.tgz) streamed from Google Drive
router.get("/:name/-/:file", async (req, res) => {
  try {
    const { name, file } = req.params;
    const cleanName = name.toLowerCase();
    const version = file.replace(`${cleanName}-`, "").replace(".tgz", "");

    const pkg = await Package.findOne({ name: cleanName });
    if (!pkg) {
      return res.status(404).json({ error: "Package not found" });
    }

    const v = await PackageVersion.findOne({ package: pkg._id, version });
    if (!v || !v.driveFileId) {
      return res.status(404).json({ error: "Package version or tarball file not found" });
    }

    // Increment download count, overall and per version per day
    pkg.downloads = (pkg.downloads || 0) + 1;
    await pkg.save();
    await DownloadStat.updateOne(
      { package: pkg._id, version, day: utcDay(new Date()) },
      { $inc: { count: 1 } },
      { upsert: true }
    );

    // Stream tarball directly from Google Drive
    const tarballBuffer = await downloadTarballFromDrive(v.driveFileId);

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${v.tarballName || `${cleanName}-${version}.tgz`}"`);
    res.setHeader("Content-Length", tarballBuffer.length.toString());
    return res.status(200).send(tarballBuffer);
  } catch (err) {
    console.error("Error serving tarball from Google Drive:", err);
    return res.status(500).json({ error: err.message || "Failed to download package from Google Drive" });
  }
});

// Unpacked tarballs, keyed by Drive file id, so browsing a package's code doesn't
// re-download the archive for every file opened. Oldest entries are evicted first.
const extractedCache = new Map();
const EXTRACTED_CACHE_SIZE = 20;
const MAX_VIEWABLE_BYTES = 512 * 1024;

async function getVersionFiles(name, version) {
  const pkg = await Package.findOne({ name: name.toLowerCase() });
  if (!pkg) return null;
  const v = await PackageVersion.findOne({ package: pkg._id, version });
  if (!v || !v.driveFileId) return null;
  if (v.driveFileId.startsWith("drive_file_")) {
    // Published before tarball storage worked: the archive was never saved.
    const error = new Error("This version's files weren't saved when it was published. Publish a new version to browse its code.");
    error.status = 410;
    throw error;
  }

  if (!extractedCache.has(v.driveFileId)) {
    const files = extractTgz(await downloadTarballFromDrive(v.driveFileId));
    extractedCache.set(v.driveFileId, files);
    if (extractedCache.size > EXTRACTED_CACHE_SIZE) {
      extractedCache.delete(extractedCache.keys().next().value);
    }
  }
  return extractedCache.get(v.driveFileId);
}

// GET /api/registry/:name/v/:version/files - List every file in a version's tarball
router.get("/:name/v/:version/files", noStore, async (req, res) => {
  try {
    const files = await getVersionFiles(req.params.name, req.params.version);
    if (!files) {
      return res.status(404).json({ error: "Package version not found." });
    }
    return res.json({
      files: files.map(({ path, buffer }) => ({ path, size: buffer.length }))
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("List files error:", err);
    return res.status(500).json({ error: err.message || "Failed to read the package's files." });
  }
});

// GET /api/registry/:name/v/:version/file?path=src/main.qc - One file's contents
router.get("/:name/v/:version/file", noStore, async (req, res) => {
  try {
    const files = await getVersionFiles(req.params.name, req.params.version);
    if (!files) {
      return res.status(404).json({ error: "Package version not found." });
    }
    const file = files.find(({ path }) => path === req.query.path);
    if (!file) {
      return res.status(404).json({ error: `File "${req.query.path}" not found in this version.` });
    }

    const binary = isBinary(file.buffer);
    const tooLarge = file.buffer.length > MAX_VIEWABLE_BYTES;
    return res.json({
      path: file.path,
      size: file.buffer.length,
      binary,
      tooLarge,
      content: binary || tooLarge ? null : file.buffer.toString("utf8")
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("Read file error:", err);
    return res.status(500).json({ error: err.message || "Failed to read the file." });
  }
});

const MIME_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ico: "image/x-icon", pdf: "application/pdf"
};

// GET /api/registry/:name/v/:version/raw?path=logo.png - A file's raw bytes (images are shown inline)
router.get("/:name/v/:version/raw", noStore, async (req, res) => {
  try {
    const files = await getVersionFiles(req.params.name, req.params.version);
    const file = files?.find(({ path }) => path === req.query.path);
    if (!file) {
      return res.status(404).json({ error: "File not found." });
    }

    const ext = file.path.split(".").pop().toLowerCase();
    const type = MIME_TYPES[ext] || (isBinary(file.buffer) ? "application/octet-stream" : "text/plain; charset=utf-8");
    res.setHeader("Content-Type", type);
    // Package files are untrusted: never let them run as a page on this origin.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(file.buffer);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("Raw file error:", err);
    return res.status(500).json({ error: err.message || "Failed to read the file." });
  }
});

// DELETE /api/registry/:name - Delete a package, every version, and their stored tarballs (owner only)
router.delete("/:name", authenticateToken, async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const pkg = await Package.findOne({ name });
    if (!pkg) {
      return res.status(404).json({ error: `Package "${name}" not found.` });
    }
    if (!pkg.owner || pkg.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: `Only the owner of "${name}" can delete it.` });
    }

    const versions = await PackageVersion.find({ package: pkg._id });
    for (const v of versions) {
      if (!v.driveFileId) continue;
      extractedCache.delete(v.driveFileId);
      try {
        await deleteTarballFromDrive(v.driveFileId);
      } catch (err) {
        // A tarball that can't be removed shouldn't block deleting the package record.
        console.error(`Failed to delete tarball ${v.driveFileId}:`, err);
      }
    }

    await PackageVersion.deleteMany({ package: pkg._id });
    await DownloadStat.deleteMany({ package: pkg._id });
    await pkg.deleteOne();

    return res.json({ message: `Package "${name}" was deleted.` });
  } catch (err) {
    console.error("Delete package error:", err);
    return res.status(500).json({ error: err.message || "Failed to delete package." });
  }
});

// POST /api/registry/publish - Publish package (handles JSON base64 or Multipart form-data file)
router.post("/publish", optionalAuthenticateToken, publishUpload, async (req, res) => {
  try {
    let { name, version, description, keywords, license, repository, homepage, readme, dependencies, fileBase64 } = req.body;

    if (!name || !version) {
      return res.status(400).json({ error: "Package name and version are required." });
    }

    name = name.toLowerCase().trim();
    version = version.trim();

    // Extract file buffer from multipart upload OR base64 payload
    let fileBuffer = Buffer.from("");
    const tarballUpload = req.files?.file?.[0];
    const looseFiles = req.files?.files ?? [];
    if (looseFiles.length) {
      // Loose files / a folder: `paths` carries each file's relative path, in upload order.
      let paths = [];
      try {
        paths = JSON.parse(req.body.paths || "[]");
      } catch {
        return res.status(400).json({ error: "Invalid file paths." });
      }

      const entries = [];
      let totalBytes = 0;
      looseFiles.forEach((file, index) => {
        const path = cleanPath(paths[index] ?? file.originalname);
        if (!path) return;
        totalBytes += file.buffer.length;
        entries.push({ path, buffer: file.buffer });
      });

      if (!entries.length) {
        return res.status(400).json({ error: "No usable files were selected." });
      }
      if (totalBytes > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: "The selected files are larger than 100 MB in total." });
      }
      fileBuffer = createTgz(entries);
    } else if (tarballUpload && tarballUpload.buffer) {
      fileBuffer = tarballUpload.buffer;
    } else if (fileBase64) {
      const cleanBase64 = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
      fileBuffer = Buffer.from(cleanBase64, "base64");
    }

    // Fill anything the form left blank from the package's own README and manifest.
    const meta = readPackageMeta(fileBuffer);
    readme = readme || meta.readme;
    description = description || meta.manifest.description || "";
    if (!keywords || !keywords.length) keywords = meta.manifest.keywords || meta.manifest.tags || keywords;
    license = license || meta.manifest.license;

    if (typeof keywords === "string") {
      keywords = keywords.split(",").map((k) => k.trim()).filter(Boolean);
    }

    let parsedDeps = {};
    if (typeof dependencies === "string") {
      try {
        parsedDeps = JSON.parse(dependencies);
      } catch (e) {
        parsedDeps = {};
      }
    } else if (dependencies && typeof dependencies === "object") {
      parsedDeps = dependencies;
    }

    // Check ownership in MongoDB
    let existingPkg = await Package.findOne({ name });
    const currentUserId = req.user ? req.user._id : null;

    if (existingPkg && existingPkg.owner && currentUserId) {
      if (existingPkg.owner.toString() !== currentUserId.toString()) {
        return res.status(403).json({ error: `Package "${name}" belongs to another author.` });
      }
    }

    if (!existingPkg) {
      existingPkg = new Package({
        name,
        description: description || "",
        keywords: keywords || [],
        license: license || "MIT",
        repository: repository || "",
        homepage: homepage || "",
        readme: readme || `# ${name}\n\n${description || "No documentation provided."}`,
        latestVersion: version,
        owner: currentUserId
      });
      await existingPkg.save();
    } else {
      // Check if version already exists
      const existingVer = await PackageVersion.findOne({ package: existingPkg._id, version });
      if (existingVer) {
        return res.status(400).json({ error: `Version ${version} of package "${name}" is already published.` });
      }

      existingPkg.description = description || existingPkg.description;
      existingPkg.keywords = keywords || existingPkg.keywords;
      existingPkg.latestVersion = version;
      if (readme) existingPkg.readme = readme;
      await existingPkg.save();
    }

    // Upload archive file to Google Drive
    const tarballName = `${name.replace("/", "-")}-${version}.tgz`;
    const driveResult = await uploadTarballToDrive(tarballName, fileBuffer);

    // Save version in MongoDB
    const packageVersion = new PackageVersion({
      package: existingPkg._id,
      version,
      description: description || "",
      dependencies: parsedDeps,
      readme: readme || "",
      tarballName,
      driveFileId: driveResult.id,
      fileSize: driveResult.size,
      publishedBy: currentUserId
    });

    await packageVersion.save();

    return res.status(201).json({
      message: `Package ${name}@${version} published successfully and stored in Google Drive!`,
      package: {
        name,
        version,
        driveFileId: driveResult.id,
        size: driveResult.size
      }
    });
  } catch (err) {
    console.error("Publish error:", err);
    return res.status(500).json({ error: err.message || "Failed to publish package." });
  }
});

// POST /api/registry/publish-from-github - Publish a package by pulling it
// straight from a public GitHub repo (no local .tgz needed).
router.post("/publish-from-github", optionalAuthenticateToken, async (req, res) => {
  try {
    const { repoUrl, branch, version, dependencies } = req.body;

    if (!repoUrl || !version) {
      return res.status(400).json({ error: "repoUrl and version are required." });
    }

    // Parse "https://github.com/owner/repo" (also tolerates a trailing
    // .git or slash) into { owner, repo }.
    const match = repoUrl
      .trim()
      .match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
    if (!match) {
      return res.status(400).json({ error: "repoUrl doesn't look like a GitHub repo URL." });
    }
    const [, owner, repo] = match;
    const ref = branch || "main";

    // 1. Read qpm.json from the repo for name/description/keywords, if present.
    let manifest = {};
    const manifestRes = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/qpm.json`
    );
    if (manifestRes.ok) {
      manifest = await manifestRes.json();
    }

    // 2. Read the repo's README to use as the package's article/description.
    let readme = "";
    const readmeRes = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/README.md`
    );
    if (readmeRes.ok) {
      readme = await readmeRes.text();
    }

    const name = (manifest.name || repo).toLowerCase().trim();
    const description = manifest.description || "";
    let keywords = manifest.tags || manifest.keywords || [];
    if (typeof keywords === "string") {
      keywords = keywords.split(",").map((k) => k.trim()).filter(Boolean);
    }

    // 3. Download the repo itself as a .tar.gz straight from GitHub — this
    // becomes the package's tarball, same as an uploaded .tgz would.
    const tarballRes = await fetch(
      `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${ref}`
    );
    if (!tarballRes.ok) {
      return res.status(400).json({
        error: `Could not download ${owner}/${repo}@${ref} from GitHub (HTTP ${tarballRes.status}). Check the repo is public and the branch name is right.`,
      });
    }
    const fileBuffer = Buffer.from(await tarballRes.arrayBuffer());
    if (!readme) readme = readPackageMeta(fileBuffer).readme;

    let parsedDeps = {};
    if (typeof dependencies === "string") {
      try {
        parsedDeps = JSON.parse(dependencies);
      } catch {
        parsedDeps = {};
      }
    } else if (dependencies && typeof dependencies === "object") {
      parsedDeps = dependencies;
    }

    // --- from here down mirrors /publish's Package/PackageVersion logic ---
    let existingPkg = await Package.findOne({ name });
    const currentUserId = req.user ? req.user._id : null;

    if (existingPkg && existingPkg.owner && currentUserId) {
      if (existingPkg.owner.toString() !== currentUserId.toString()) {
        return res.status(403).json({ error: `Package "${name}" belongs to another author.` });
      }
    }

    if (!existingPkg) {
      existingPkg = new Package({
        name,
        description,
        keywords,
        license: manifest.license || "MIT",
        repository: repoUrl,
        homepage: manifest.homepage || repoUrl,
        readme: readme || `# ${name}\n\n${description || "No documentation provided."}`,
        latestVersion: version,
        owner: currentUserId,
      });
      await existingPkg.save();
    } else {
      const existingVer = await PackageVersion.findOne({ package: existingPkg._id, version });
      if (existingVer) {
        return res.status(400).json({ error: `Version ${version} of package "${name}" is already published.` });
      }

      existingPkg.description = description || existingPkg.description;
      existingPkg.keywords = keywords.length ? keywords : existingPkg.keywords;
      existingPkg.repository = repoUrl;
      existingPkg.latestVersion = version;
      if (readme) existingPkg.readme = readme;
      await existingPkg.save();
    }

    const tarballName = `${name.replace("/", "-")}-${version}.tgz`;
    const driveResult = await uploadTarballToDrive(tarballName, fileBuffer);

    const packageVersion = new PackageVersion({
      package: existingPkg._id,
      version,
      description,
      dependencies: parsedDeps,
      readme,
      tarballName,
      driveFileId: driveResult.id,
      fileSize: driveResult.size,
      publishedBy: currentUserId,
    });
    await packageVersion.save();

    return res.status(201).json({
      message: `Package ${name}@${version} imported from ${owner}/${repo} and stored in Google Drive!`,
      package: { name, version, driveFileId: driveResult.id, size: driveResult.size },
    });
  } catch (err) {
    console.error("Publish-from-GitHub error:", err);
    return res.status(500).json({ error: err.message || "Failed to publish from GitHub." });
  }
});

export default router;
