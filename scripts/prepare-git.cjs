"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execSync } = require("child_process");

// PortableGit (not MinGit) — MinGit ships without bash.exe, which we need for
// pi-coding-agent's bash tool. PortableGit is a self-extracting 7z archive
// that contains a complete bash + msys runtime.
const GIT_VERSION = "2.47.0.2";
const ARCHIVE_NAME = `PortableGit-${GIT_VERSION}-64-bit.7z.exe`;
const DOWNLOAD_URL = `https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.2/${ARCHIVE_NAME}`;
const EXPECTED_SHA256 =
  process.env.PORTABLEGIT_SHA256 ||
  "c77368a8f6ccbd43bde0df0ab603133ce885407a018787d6f1971e040590f1ab";

const cacheDir = path.join(__dirname, "..", "build", "git-cache");
const outDir = path.join(__dirname, "..", "build", "git");
const archivePath = path.join(cacheDir, ARCHIVE_NAME);
const versionMarker = path.join(outDir, ".version");

function isUpToDate() {
  try {
    if (!fs.existsSync(versionMarker)) return false;
    return fs.readFileSync(versionMarker, "utf8").trim() === GIT_VERSION;
  } catch {
    return false;
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    const file = fs.createWriteStream(tmp);

    const get = (currentUrl) => {
      https
        .get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlink(tmp, () => {});
            reject(new Error(`Download failed: ${res.statusCode} ${currentUrl}`));
            return;
          }
          const total = parseInt(res.headers["content-length"] || "0", 10);
          let received = 0;
          let lastLogged = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            if (total && received - lastLogged > 4 * 1024 * 1024) {
              const pct = ((received / total) * 100).toFixed(0);
              process.stdout.write(`  ${pct}%\r`);
              lastLogged = received;
            }
          });
          res.pipe(file);
          file.on("finish", () => {
            file.close((err) => {
              if (err) {
                reject(err);
                return;
              }
              fs.renameSync(tmp, dest);
              resolve();
            });
          });
        })
        .on("error", (err) => {
          file.close();
          fs.unlink(tmp, () => {});
          reject(err);
        });
    };

    get(url);
  });
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(1024 * 1024);
  let bytes;
  while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, bytes));
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // PortableGit is a self-extracting 7z. Silent extract: -y -o<dest>
    execSync(`"${archive}" -y -o"${dest}"`, { stdio: "inherit" });
  } else {
    // Cross-compile from non-Windows: requires 7z/p7zip installed.
    execSync(`7z x -y -o"${dest}" "${archive}"`, { stdio: "inherit" });
  }
}

function pruneForBundle(root) {
  // PortableGit extracts to ~280 MB. We only need bash + msys runtime, not
  // git itself or the GUI tools. Point the app at usr/bin/bash.exe (the
  // top-level bin/bash.exe wrapper breaks without mingw64). This trims
  // ~170 MB, leaving ~110 MB for bash + coreutils.
  const removable = [
    "mingw64",
    "cmd",
    "dev",
    "tmp",
    "git-bash.exe",
    "git-cmd.exe",
    "post-install.bat",
    "README.portable",
    "bin/git.exe",
    "usr/share/vim",
    "usr/share/gtk-doc",
    "usr/share/git",
    "usr/share/misc",
    "usr/share/perl5",
    "usr/lib/perl5",
    "usr/share/doc",
    "usr/share/man",
    "usr/share/info",
    "usr/share/locale",
    "usr/share/nano",
    "usr/share/gnupg",
    "usr/share/pki",
    "usr/share/gtk-3.0",
    "usr/share/mintty",
    "usr/ssl",
    "usr/bin/vim.exe",
    "usr/bin/vimdiff.exe",
    "usr/bin/view.exe",
    "usr/bin/ex.exe",
    "usr/bin/rvim.exe",
    "usr/bin/rview.exe",
    "usr/bin/msys-perl5_38.dll",
    "usr/lib/gnupg",
    "usr/lib/ssh",
  ];
  for (const rel of removable) {
    rmrf(path.join(root, rel));
  }
}

(async () => {
  if (isUpToDate()) {
    console.log(`PortableGit ${GIT_VERSION} already staged at ${outDir}`);
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  if (!fs.existsSync(archivePath)) {
    console.log(`Downloading ${ARCHIVE_NAME}...`);
    await download(DOWNLOAD_URL, archivePath);
  } else {
    console.log(`Using cached ${archivePath}`);
  }

  const actualSha = sha256(archivePath);
  if (EXPECTED_SHA256) {
    if (actualSha.toLowerCase() !== EXPECTED_SHA256.toLowerCase()) {
      fs.unlinkSync(archivePath);
      throw new Error(
        `SHA-256 mismatch for ${ARCHIVE_NAME}\n  expected: ${EXPECTED_SHA256}\n  actual:   ${actualSha}`,
      );
    }
    console.log(`SHA-256 verified: ${actualSha}`);
  } else {
    console.warn(
      `WARNING: No EXPECTED_SHA256 pinned. Downloaded SHA-256: ${actualSha}\n` +
        `         Set PORTABLEGIT_SHA256 env var or hard-code it in scripts/prepare-git.cjs to enable verification.`,
    );
  }

  console.log(`Extracting to ${outDir}...`);
  rmrf(outDir);
  extract(archivePath, outDir);

  const bashPath = path.join(outDir, "bin", "bash.exe");
  if (!fs.existsSync(bashPath)) {
    throw new Error(`Extraction did not produce ${bashPath}`);
  }

  console.log("Pruning unused PortableGit components...");
  pruneForBundle(outDir);

  fs.writeFileSync(versionMarker, GIT_VERSION);
  console.log(`PortableGit ${GIT_VERSION} ready at ${outDir}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
