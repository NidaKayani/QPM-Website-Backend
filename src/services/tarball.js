import zlib from "node:zlib";

const BLOCK = 512;

// Writes `value` into `header` at `offset` as a NUL-terminated octal number.
function writeOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(BLOCK);
  header.write(name.slice(0, 100), 0, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156); // checksum field is spaces while summing
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

const padded = (buffer) => {
  const remainder = buffer.length % BLOCK;
  return remainder ? Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder)]) : buffer;
};

/**
 * Builds an npm-style gzip'd tarball (every entry under `package/`) from in-memory files.
 * @param {{ path: string, buffer: Buffer }[]} files
 * @returns {Buffer}
 */
export function createTgz(files) {
  const parts = [];

  for (const { path, buffer } of files) {
    const name = `package/${path}`;
    if (Buffer.byteLength(name) > 100) {
      // GNU long-name entry carrying the real path for the entry that follows.
      const longName = Buffer.from(`${name}\0`);
      parts.push(tarHeader("././@LongLink", longName.length, "L"), padded(longName));
    }
    parts.push(tarHeader(name, buffer.length), padded(buffer));
  }

  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return zlib.gzipSync(Buffer.concat(parts));
}

const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".DS_Store"]);

/** Normalises a client-supplied relative path; returns null if it is unsafe or ignored. */
export function cleanPath(raw) {
  if (typeof raw !== "string") return null;
  const segments = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === ".." || segment === ".")) return null;
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return null;
  return segments.join("/");
}

const readString = (block, offset, length) => {
  const end = block.indexOf(0, offset);
  return block.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
};

const readOctal = (block, offset, length) => parseInt(readString(block, offset, length).trim() || "0", 8);

/** Pulls `path=` out of a PAX extended header body. */
function paxPath(body) {
  for (const record of body.toString("utf8").split("\n")) {
    const match = record.match(/^\d+ path=(.*)$/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Reads the regular files out of a (gzip'd) tarball. The archive's single top-level
 * folder (`package/` for npm-style tarballs, `repo-branch/` for GitHub's) is stripped.
 * @param {Buffer} archive
 * @returns {{ path: string, buffer: Buffer }[]}
 */
export function extractTgz(archive) {
  if (!archive?.length) return [];
  const tar = archive[0] === 0x1f && archive[1] === 0x8b ? zlib.gunzipSync(archive) : archive;

  const files = [];
  let offset = 0;
  let nextName = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      nextName = readString(body, 0, body.length);
      continue;
    }
    if (type === "x") {
      nextName = paxPath(body) ?? nextName;
      continue;
    }
    if (type === "g") continue;

    const prefix = readString(header, 345, 155);
    const name = nextName ?? (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
    nextName = null;

    if (type !== "0" && type !== "7") continue; // only regular files
    const path = cleanPath(name);
    if (path) files.push({ path, buffer: Buffer.from(body) });
  }

  // Strip the shared top-level folder, if every file lives under one.
  const roots = new Set(files.map(({ path }) => (path.includes("/") ? path.split("/")[0] : null)));
  if (roots.size === 1 && !roots.has(null)) {
    const [root] = roots;
    for (const file of files) file.path = file.path.slice(root.length + 1);
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Heuristic: a NUL byte in the first 8 KB means binary (same check git uses). */
export const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

/**
 * Reads the root README and manifest (qpm.json, else package.json) out of a package archive,
 * so a publish without a typed-in README or description still gets them.
 * @returns {{ readme: string, manifest: object }}
 */
export function readPackageMeta(archive) {
  let files = [];
  try {
    files = extractTgz(archive);
  } catch {
    return { readme: "", manifest: {} };
  }

  const atRoot = (pattern) => files.find(({ path }) => !path.includes("/") && pattern.test(path));
  const readme = atRoot(/^readme(\.(md|markdown|txt))?$/i);

  let manifest = {};
  for (const name of [/^qpm\.json$/i, /^package\.json$/i]) {
    const file = atRoot(name);
    if (!file) continue;
    try {
      manifest = JSON.parse(file.buffer.toString("utf8"));
      break;
    } catch {
      // Malformed manifest: try the next one.
    }
  }

  return { readme: readme ? readme.buffer.toString("utf8") : "", manifest };
}
