import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

// Without Drive credentials, tarballs are kept on local disk under backend/storage/.
const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../storage");
const LOCAL_PREFIX = "local_";
const localPath = (fileId) => path.join(LOCAL_DIR, `${path.basename(fileId)}.tgz`);

/**
 * Google Drive API Service Module for QPM Registry
 * 
 * Uploads package tarballs (.tgz) to a Google Drive folder, downloads/streams tarballs
 * by driveFileId, and handles Service Account authentication.
 */

async function getAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.error("Failed to refresh Google OAuth access token:", err);
    return null;
  }
}

/**
 * Uploads package tarball buffer to Google Drive.
 * Returns { id, size }
 */
export async function uploadTarballToDrive(fileName, buffer) {
  const token = await getAccessToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!token) {
    const id = `${LOCAL_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(localPath(id), buffer);
    console.log(`[Google Drive] Credentials not set. Stored ${fileName} locally as ${id}`);
    return { id, size: buffer.length };
  }

  const metadata = {
    name: fileName,
    parents: folderId ? [folderId] : []
  };

  const boundary = "-------314159265358979323846";
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const multipartBody = Buffer.concat([
    Buffer.from(
      `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
    ),
    Buffer.from(`${delimiter}Content-Type: application/gzip\r\n\r\n`),
    buffer,
    Buffer.from(closeDelimiter)
  ]);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": multipartBody.length.toString()
    },
    body: multipartBody
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive upload failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    id: data.id,
    size: buffer.length
  };
}

/**
 * Downloads a tarball buffer from Google Drive by driveFileId.
 * Returns Buffer
 */
export async function downloadTarballFromDrive(fileId) {
  if (fileId.startsWith(LOCAL_PREFIX)) {
    return fs.readFile(localPath(fileId));
  }

  const token = await getAccessToken();

  // Old mock ids: the archive was never stored anywhere.
  if (!token || fileId.startsWith("drive_file_")) {
    console.log(`[Google Drive] Serving local placeholder archive for ID ${fileId}`);
    return Buffer.from("");
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to download file from Google Drive (${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Deletes a tarball file from Google Drive.
 */
export async function deleteTarballFromDrive(fileId) {
  if (fileId.startsWith(LOCAL_PREFIX)) {
    await fs.rm(localPath(fileId), { force: true });
    return;
  }
  const token = await getAccessToken();
  if (!token || fileId.startsWith("drive_file_")) return;

  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
}
