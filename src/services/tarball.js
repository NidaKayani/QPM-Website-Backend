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
