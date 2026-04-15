const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", "build", "ffmpeg");
fs.mkdirSync(outDir, { recursive: true });

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

fs.copyFileSync(ffmpegPath, path.join(outDir, path.basename(ffmpegPath)));
fs.copyFileSync(ffprobePath, path.join(outDir, path.basename(ffprobePath)));

console.log(`Copied ffmpeg  -> ${path.join(outDir, path.basename(ffmpegPath))}`);
console.log(`Copied ffprobe -> ${path.join(outDir, path.basename(ffprobePath))}`);
