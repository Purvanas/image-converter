const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const archiver = require("archiver");
const { getMediaKind, getOutputFormats } = require("./mediaTypes");
const { csvToJson, jsonToCsv, stripBom } = require("./dataConverters");
const { buildPreviewMeta } = require("./previewMeta");

if (process.env.FFMPEG_BIN) ffmpeg.setFfmpegPath(process.env.FFMPEG_BIN);
if (process.env.FFPROBE_BIN) ffmpeg.setFfprobePath(process.env.FFPROBE_BIN);

const app = express();
const execFileAsync = promisify(execFile);
const PORT = process.env.PORT || 3400;
const HOST = process.env.HOST || "127.0.0.1";
const RUNTIME_DIR = process.env.RUNTIME_DIR || __dirname;
const UPLOAD_DIR = path.join(RUNTIME_DIR, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_CODE = process.env.ADMIN_CODE || "";
const ERRORS_TOKEN = process.env.ERRORS_TOKEN || "";
const MAX_IMAGE_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_PDF_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_DATA_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_AUDIO_SIZE = 300 * 1024 * 1024; // 300 MB
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_IMAGE_PDF_FILES = 50;
const ADMIN_MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB (no real limit)
const PUBLIC_UPLOAD_MAX_SIZE = positiveBytes(process.env.PUBLIC_UPLOAD_MAX_BYTES, MAX_VIDEO_SIZE);
const ADMIN_UPLOAD_MAX_SIZE = positiveBytes(process.env.ADMIN_UPLOAD_MAX_BYTES, ADMIN_MAX_SIZE);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== SECURITY =====
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString("hex");
    const candidate = path.extname(file.originalname).toLowerCase();
    const ext = /^\.[a-z0-9]{1,10}$/.test(candidate) ? candidate : "";
    cb(null, id + ext);
  },
});
function matchesAdminCode(value) {
  if (!ADMIN_CODE || typeof value !== "string") return false;
  const expected = Buffer.from(ADMIN_CODE);
  const received = Buffer.from(value);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function isAdmin(req) {
  return req.uploadAdmin === true || matchesAdminCode(req.body?.adminCode);
}

function positiveBytes(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createUpload(fileSize) {
  return multer({
    storage,
    limits: {
      fileSize,
      files: MAX_IMAGE_PDF_FILES,
      fields: 12,
      parts: MAX_IMAGE_PDF_FILES + 12,
      fieldNameSize: 100,
      fieldSize: 64 * 1024,
      fieldArrayIndexLimit: 0,
      headerPairs: 100,
    },
  });
}

const publicUpload = createUpload(PUBLIC_UPLOAD_MAX_SIZE);
const adminUpload = createUpload(ADMIN_UPLOAD_MAX_SIZE);

function selectUpload(publicMiddleware, adminMiddleware) {
  return (req, res, next) => {
    req.uploadAdmin = matchesAdminCode(req.get("x-admin-code"));
    const middleware = req.uploadAdmin ? adminMiddleware : publicMiddleware;
    middleware(req, res, next);
  };
}

function singleUpload(field) {
  return selectUpload(publicUpload.single(field), adminUpload.single(field));
}

function arrayUpload(field, maxCount) {
  return selectUpload(publicUpload.array(field, maxCount), adminUpload.array(field, maxCount));
}

function hasErrorsToken(req) {
  if (!ERRORS_TOKEN) return false;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const expected = Buffer.from(ERRORS_TOKEN);
  const received = Buffer.from(authorization.slice(7));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function requireErrorsToken(req, res, next) {
  if (!hasErrorsToken(req)) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

function runFfmpeg(command, outputPath, timeoutMs, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (res) res.off("close", abort);
      fn(value);
    };
    const abort = () => {
      if (res?.writableEnded) return;
      finish(reject, new Error("Conversion annulée"));
      try { command.kill("SIGKILL"); } catch { /* best effort */ }
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("Conversion trop longue"));
      try { command.kill("SIGKILL"); } catch { /* best effort */ }
    }, timeoutMs);
    if (res) res.once("close", abort);
    command.once("end", () => finish(resolve));
    command.once("error", (err) => finish(reject, err));
    try {
      command.save(outputPath);
    } catch (err) {
      finish(reject, err);
    }
  });
}

// Track active video conversions
let activeVideoJobs = 0;
const MAX_VIDEO_JOBS = 1;
let activeAudioJobs = 0;
const MAX_AUDIO_JOBS = 2;

// Cleanup old files (> 10 min)
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const fp = path.join(UPLOAD_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}, 60_000);
cleanupTimer.unref();

// ===== STATS =====
const STATS_FILE = path.join(RUNTIME_DIR, "stats.json");
let stats = {
  images: 0,
  videos: 0,
  audios: 0,
  pdfs: 0,
  data: 0,
  totalImageInputBytes: 0,
  totalImageOutputBytes: 0,
  totalVideoInputBytes: 0,
  totalVideoOutputBytes: 0,
  totalAudioInputBytes: 0,
  totalAudioOutputBytes: 0,
  totalPdfInputBytes: 0,
  totalPdfOutputBytes: 0,
  totalDataInputBytes: 0,
  totalDataOutputBytes: 0,
};
if (fs.existsSync(STATS_FILE)) {
  try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, "utf-8")) }; } catch {}
}
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); }
const statsTimer = setInterval(saveStats, 30_000);
statsTimer.unref();

function humanSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function outputExt(format) {
  if (format === "jpeg") return "jpg";
  return format;
}

function sendConversionResult(res, { outputName, downloadName, originalSize, convertedSize, format }) {
  res.json({
    downloadUrl: `/api/download/${outputName}?name=${encodeURIComponent(downloadName)}`,
    preview: buildPreviewMeta(outputName, format, convertedSize),
    originalSize: humanSize(originalSize),
    convertedSize: humanSize(convertedSize),
    format,
  });
}

function saveBufferResult(res, buffer, originalName, format, statKey, inputBytes) {
  const ext = outputExt(format);
  const outputName = crypto.randomBytes(8).toString("hex") + "." + ext;
  const outputPath = path.join(UPLOAD_DIR, outputName);
  fs.writeFileSync(outputPath, buffer);
  const stat = fs.statSync(outputPath);
  const downloadName = path.parse(originalName).name + "." + ext;

  if (statKey === "pdf") {
    stats.pdfs++;
    stats.totalPdfInputBytes += inputBytes;
    stats.totalPdfOutputBytes += stat.size;
  } else if (statKey === "data") {
    stats.data++;
    stats.totalDataInputBytes += inputBytes;
    stats.totalDataOutputBytes += stat.size;
  }
  saveStats();

  sendConversionResult(res, {
    outputName,
    downloadName,
    originalSize: inputBytes,
    convertedSize: stat.size,
    format,
  });
}

function getPageSize(size, orientation, imageWidth, imageHeight) {
  let page;
  if (size === "letter") page = [612, 792];
  else if (size === "a4") page = [595.28, 841.89];
  else page = [imageWidth, imageHeight];

  if (orientation === "landscape" || (orientation === "auto" && imageWidth > imageHeight && page[1] > page[0])) {
    page = [Math.max(page[0], page[1]), Math.min(page[0], page[1])];
  } else if (orientation === "portrait") {
    page = [Math.min(page[0], page[1]), Math.max(page[0], page[1])];
  }

  return page;
}

async function createPdfFromImages(files, options = {}) {
  const pdfDoc = await PDFDocument.create();
  const pageSize = options.pageSize || "auto";
  const orientation = options.orientation || "auto";
  const fit = options.fit || "contain";
  const margin = clampNumber(options.margin, 0, 0, 144);

  for (const file of files) {
    const converted = await sharp(file.path)
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });

    const image = await pdfDoc.embedPng(converted.data);
    const [pageWidth, pageHeight] = getPageSize(pageSize, orientation, converted.info.width, converted.info.height);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const usableWidth = Math.max(pageWidth - margin * 2, 1);
    const usableHeight = Math.max(pageHeight - margin * 2, 1);
    const scaleFn = fit === "cover" ? Math.max : Math.min;
    const scale = scaleFn(usableWidth / image.width, usableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return Buffer.from(await pdfDoc.save());
}

async function zipFiles(files, outputPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    files.forEach((file) => archive.file(file, { name: path.basename(file) }));
    archive.finalize();
  });
}

// ===== IMAGE CONVERSION =====
const IMAGE_FORMATS = getOutputFormats("image");
const IMAGE_MIMES = {
  "image/jpeg": true, "image/png": true, "image/webp": true,
  "image/avif": true, "image/tiff": true, "image/gif": true,
  "image/bmp": true, "image/svg+xml": true, "image/heic": true, "image/heif": true,
};

app.post("/api/convert/image", singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  if (getMediaKind(req.file) !== "image") {
    cleanup(req.file.path);
    return res.status(400).json({ error: "Ce fichier n'est pas une image compatible" });
  }
  const admin = isAdmin(req);
  if (!admin && req.file.size > MAX_IMAGE_SIZE) {
    cleanup(req.file.path);
    return res.status(413).json({ error: `Image trop lourde (max ${humanSize(MAX_IMAGE_SIZE)})` });
  }

  const format = req.body.format || "jpeg";
  if (!IMAGE_FORMATS.includes(format)) {
    cleanup(req.file.path);
    return res.status(400).json({ error: `Format invalide. Formats: ${IMAGE_FORMATS.join(", ")}` });
  }

  const quality = Math.min(Math.max(parseInt(req.body.quality) || 85, 1), 100);
  const width = parseInt(req.body.width) || null;
  const height = parseInt(req.body.height) || null;

  if (format === "pdf") {
    try {
      const pdfBuffer = await createPdfFromImages([req.file], req.body);
      return saveBufferResult(res, pdfBuffer, req.file.originalname, "pdf", "pdf", req.file.size);
    } catch (err) {
      console.error("[IMAGE→PDF] Error:", err.message);
      logError("conversion", err.message, { type: "image-pdf" });
      return res.status(500).json({ error: "Erreur de conversion: " + err.message });
    } finally {
      cleanup(req.file.path);
    }
  }

  const outputName = crypto.randomBytes(8).toString("hex") + "." + (format === "jpeg" ? "jpg" : format);
  const outputPath = path.join(UPLOAD_DIR, outputName);

  try {
    let pipeline = sharp(req.file.path);

    // Resize if requested
    if (width || height) {
      pipeline = pipeline.resize(width || null, height || null, { fit: "inside", withoutEnlargement: true });
    }

    // Convert
    const formatOpts = {};
    if (format === "jpeg") formatOpts.quality = quality;
    else if (format === "webp") formatOpts.quality = quality;
    else if (format === "avif") formatOpts.quality = quality;
    else if (format === "png") formatOpts.compressionLevel = Math.round((100 - quality) / 11);
    else if (format === "tiff") formatOpts.quality = quality;

    await pipeline.toFormat(format, formatOpts).toFile(outputPath);

    const stat = fs.statSync(outputPath);
    const origName = path.parse(req.file.originalname).name + "." + (format === "jpeg" ? "jpg" : format);

    stats.images++;
    stats.totalImageInputBytes += req.file.size;
    stats.totalImageOutputBytes += stat.size;
    saveStats();

    console.log(`[IMAGE] ${req.file.originalname} → ${format} (${humanSize(req.file.size)} → ${humanSize(stat.size)})`);

    sendConversionResult(res, {
      outputName,
      downloadName: origName,
      originalSize: req.file.size,
      convertedSize: stat.size,
      format,
    });
  } catch (err) {
    console.error("[IMAGE] Error:", err.message);
    logError("conversion", err.message, { type: "image" }); res.status(500).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    cleanup(req.file.path);
  }
});

// ===== VIDEO CONVERSION =====
const VIDEO_FORMATS = { mp4: "mp4", webm: "webm", gif: "gif" };
const VIDEO_MIMES = {
  "video/mp4": true, "video/webm": true, "video/x-matroska": true,
  "video/avi": true, "video/x-msvideo": true, "video/quicktime": true,
  "video/x-flv": true, "video/ogg": true, "video/3gpp": true,
};

app.post("/api/convert/video", singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  if (getMediaKind(req.file) !== "video") {
    cleanup(req.file.path);
    return res.status(400).json({ error: "Ce fichier n'est pas une video compatible" });
  }
  const admin = isAdmin(req);

  if (!admin && activeVideoJobs >= MAX_VIDEO_JOBS) {
    cleanup(req.file.path);
    return res.status(503).json({ error: "Serveur occupe. Reessayez dans quelques minutes." });
  }

  const format = req.body.format || "mp4";
  if (!VIDEO_FORMATS[format]) {
    cleanup(req.file.path);
    return res.status(400).json({ error: `Format invalide. Formats: ${Object.keys(VIDEO_FORMATS).join(", ")}` });
  }

  const quality = req.body.quality || "medium"; // low, medium, high
  const outputName = crypto.randomBytes(8).toString("hex") + "." + format;
  const outputPath = path.join(UPLOAD_DIR, outputName);

  activeVideoJobs++;

  try {
    let cmd = ffmpeg(req.file.path).outputFormat(format);

    if (format === "gif") {
      // GIF: width/fps/duration depend on quality (admin gets larger)
      let gifWidth, gifFps, gifDuration;
      if (admin && quality === "high") {
        gifWidth = 1080; gifFps = 24; gifDuration = 30;
      } else if (quality === "high") {
        gifWidth = 720; gifFps = 20; gifDuration = 15;
      } else if (quality === "low") {
        gifWidth = 360; gifFps = 10; gifDuration = 8;
      } else {
        // medium (default)
        gifWidth = 480; gifFps = 15; gifDuration = 10;
      }
      cmd = cmd
        .duration(gifDuration)
        .fps(gifFps)
        .outputOptions(["-vf", `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`]);
    } else if (format === "mp4") {
      cmd = cmd.videoCodec("libx264").audioCodec("aac");
      if (quality === "low") cmd = cmd.videoBitrate("500k").audioBitrate("64k");
      else if (quality === "high") cmd = cmd.videoBitrate("4000k").audioBitrate("192k");
      else cmd = cmd.videoBitrate("1500k").audioBitrate("128k");
    } else if (format === "webm") {
      cmd = cmd.videoCodec("libvpx-vp9").audioCodec("libopus");
      if (quality === "low") cmd = cmd.videoBitrate("500k").audioBitrate("64k");
      else if (quality === "high") cmd = cmd.videoBitrate("4000k").audioBitrate("192k");
      else cmd = cmd.videoBitrate("1500k").audioBitrate("128k");
    }

    await runFfmpeg(cmd, outputPath, admin ? 30 * 60_000 : 3 * 60_000, res);

    const stat = fs.statSync(outputPath);
    const origName = path.parse(req.file.originalname).name + "." + format;

    stats.videos++;
    stats.totalVideoInputBytes += req.file.size;
    stats.totalVideoOutputBytes += stat.size;
    saveStats();

    console.log(`[VIDEO] ${req.file.originalname} → ${format} (${humanSize(req.file.size)} → ${humanSize(stat.size)})`);

    sendConversionResult(res, {
      outputName,
      downloadName: origName,
      originalSize: req.file.size,
      convertedSize: stat.size,
      format,
    });
  } catch (err) {
    console.error("[VIDEO] Error:", err.message);
    cleanup(outputPath);
    logError("conversion", err.message, { type: "video" }); res.status(500).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    activeVideoJobs--;
    cleanup(req.file.path);
  }
});

// ===== AUDIO CONVERSION =====
const AUDIO_FORMATS = getOutputFormats("audio");

app.post("/api/convert/audio", singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const inputKind = getMediaKind(req.file);
  if (inputKind !== "audio" && inputKind !== "video") {
    cleanup(req.file.path);
    return res.status(400).json({ error: "Ce fichier ne contient pas d'audio compatible" });
  }

  const admin = isAdmin(req);
  const maxInputSize = inputKind === "video" ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE;
  if (!admin && req.file.size > maxInputSize) {
    cleanup(req.file.path);
    return res.status(413).json({ error: `Fichier trop lourd (max ${humanSize(maxInputSize)})` });
  }

  if (!admin && activeAudioJobs >= MAX_AUDIO_JOBS) {
    cleanup(req.file.path);
    return res.status(503).json({ error: "Serveur occupe. Reessayez dans quelques minutes." });
  }

  const format = (req.body.format || "mp3").toLowerCase();
  if (!AUDIO_FORMATS.includes(format)) {
    cleanup(req.file.path);
    return res.status(400).json({ error: `Format invalide. Formats: ${AUDIO_FORMATS.join(", ")}` });
  }

  const quality = req.body.quality || "medium";
  const outputName = crypto.randomBytes(8).toString("hex") + "." + format;
  const outputPath = path.join(UPLOAD_DIR, outputName);
  const bitrate = quality === "low" ? "96k" : quality === "high" ? "320k" : "192k";

  activeAudioJobs++;

  try {
    let cmd = ffmpeg(req.file.path).noVideo().audioBitrate(bitrate);

    if (format === "mp3") cmd = cmd.audioCodec("libmp3lame").outputFormat("mp3");
    else if (format === "wav") cmd = cmd.audioCodec("pcm_s16le").outputFormat("wav");
    else if (format === "ogg") cmd = cmd.audioCodec("libvorbis").outputFormat("ogg");
    else if (format === "opus") cmd = cmd.audioCodec("libopus").outputFormat("opus");
    else if (format === "flac") cmd = cmd.audioCodec("flac").outputFormat("flac");
    else if (format === "aac") cmd = cmd.audioCodec("aac").outputFormat("adts");
    else if (format === "m4a") cmd = cmd.audioCodec("aac").outputFormat("mp4");
    else if (format === "wma") cmd = cmd.audioCodec("wmav2").outputFormat("asf");

    await runFfmpeg(cmd, outputPath, admin ? 20 * 60_000 : 3 * 60_000, res);

    const stat = fs.statSync(outputPath);
    const origName = path.parse(req.file.originalname).name + "." + format;

    stats.audios++;
    stats.totalAudioInputBytes += req.file.size;
    stats.totalAudioOutputBytes += stat.size;
    saveStats();

    console.log(`[AUDIO] ${req.file.originalname} → ${format} (${humanSize(req.file.size)} → ${humanSize(stat.size)})`);

    sendConversionResult(res, {
      outputName,
      downloadName: origName,
      originalSize: req.file.size,
      convertedSize: stat.size,
      format,
    });
  } catch (err) {
    console.error("[AUDIO] Error:", err.message);
    cleanup(outputPath);
    logError("conversion", err.message, { type: "audio" });
    res.status(500).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    activeAudioJobs--;
    cleanup(req.file.path);
  }
});

// ===== PDF CONVERSION =====
const PDF_FORMATS = getOutputFormats("pdf");

app.post("/api/convert/pdf", singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  if (getMediaKind(req.file) !== "pdf") {
    cleanup(req.file.path);
    return res.status(400).json({ error: "Ce fichier n'est pas un PDF compatible" });
  }

  const admin = isAdmin(req);
  if (!admin && req.file.size > MAX_PDF_SIZE) {
    cleanup(req.file.path);
    return res.status(413).json({ error: `PDF trop lourd (max ${humanSize(MAX_PDF_SIZE)})` });
  }

  const format = (req.body.format || "png").toLowerCase();
  if (!PDF_FORMATS.includes(format)) {
    cleanup(req.file.path);
    return res.status(400).json({ error: `Format invalide. Formats: ${PDF_FORMATS.join(", ")}` });
  }

  const dpi = clampNumber(req.body.dpi, 200, 72, admin ? 600 : 300);
  const quality = clampNumber(req.body.quality, 90, 1, 100);
  const page = String(req.body.page || "all").trim().toLowerCase();
  const prefix = path.join(UPLOAD_DIR, crypto.randomBytes(8).toString("hex"));
  const args = ["-r", String(dpi), format === "jpg" ? "-jpeg" : "-png"];
  if (format === "jpg") args.push("-jpegopt", `quality=${quality}`);

  const pageNumber = page === "all" ? null : parseInt(page, 10);
  if (pageNumber && pageNumber > 0) args.push("-f", String(pageNumber), "-l", String(pageNumber));
  args.push(req.file.path, prefix);

  try {
    await execFileAsync(process.env.PDFTOPPM_BIN || "pdftoppm", args, { timeout: admin ? 10 * 60_000 : 3 * 60_000 });
    const ext = format === "jpg" ? "jpg" : "png";
    const produced = fs.readdirSync(UPLOAD_DIR)
      .filter((file) => file.startsWith(path.basename(prefix) + "-") && file.endsWith("." + ext))
      .map((file) => path.join(UPLOAD_DIR, file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!produced.length) throw new Error("Aucune page generee");

    let outputName;
    let outputPath;
    let downloadName;
    if (produced.length === 1) {
      outputPath = produced[0];
      outputName = path.basename(outputPath);
      downloadName = path.parse(req.file.originalname).name + "." + ext;
    } else {
      outputName = crypto.randomBytes(8).toString("hex") + ".zip";
      outputPath = path.join(UPLOAD_DIR, outputName);
      await zipFiles(produced, outputPath);
      produced.forEach(cleanup);
      downloadName = path.parse(req.file.originalname).name + "-" + format + ".zip";
    }

    const stat = fs.statSync(outputPath);
    stats.pdfs++;
    stats.totalPdfInputBytes += req.file.size;
    stats.totalPdfOutputBytes += stat.size;
    saveStats();

    console.log(`[PDF] ${req.file.originalname} → ${format} (${humanSize(req.file.size)} → ${humanSize(stat.size)})`);
    sendConversionResult(res, {
      outputName,
      downloadName,
      originalSize: req.file.size,
      convertedSize: stat.size,
      format: produced.length === 1 ? format : "zip",
    });
  } catch (err) {
    console.error("[PDF] Error:", err.message);
    logError("conversion", err.message, { type: "pdf" });
    res.status(500).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    cleanup(req.file.path);
  }
});

app.post("/api/convert/images-pdf", arrayUpload("files", MAX_IMAGE_PDF_FILES), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files" });
  const admin = isAdmin(req);
  const totalInputBytes = files.reduce((sum, file) => sum + file.size, 0);

  if (files.some((file) => getMediaKind(file) !== "image")) {
    files.forEach((file) => cleanup(file.path));
    return res.status(400).json({ error: "Tous les fichiers doivent etre des images compatibles" });
  }
  if (!admin && totalInputBytes > MAX_IMAGE_SIZE) {
    files.forEach((file) => cleanup(file.path));
    return res.status(413).json({ error: `Images trop lourdes (max ${humanSize(MAX_IMAGE_SIZE)})` });
  }

  try {
    const pdfBuffer = await createPdfFromImages(files, req.body);
    saveBufferResult(res, pdfBuffer, files[0].originalname.replace(/\.[^.]+$/, "-images"), "pdf", "pdf", totalInputBytes);
  } catch (err) {
    console.error("[IMAGES→PDF] Error:", err.message);
    logError("conversion", err.message, { type: "images-pdf" });
    res.status(500).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    files.forEach((file) => cleanup(file.path));
  }
});

// ===== DATA CONVERSION =====
const DATA_FORMATS = getOutputFormats("data");

app.post("/api/convert/data", singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  if (getMediaKind(req.file) !== "data") {
    cleanup(req.file.path);
    return res.status(400).json({ error: "Ce fichier n'est pas un JSON ou CSV compatible" });
  }

  const admin = isAdmin(req);
  if (!admin && req.file.size > MAX_DATA_SIZE) {
    cleanup(req.file.path);
    return res.status(413).json({ error: `Fichier data trop lourd (max ${humanSize(MAX_DATA_SIZE)})` });
  }

  const format = (req.body.format || "csv").toLowerCase();
  if (!DATA_FORMATS.includes(format)) {
    cleanup(req.file.path);
    return res.status(400).json({ error: `Format invalide. Formats: ${DATA_FORMATS.join(", ")}` });
  }

  try {
    const input = fs.readFileSync(req.file.path, "utf8");
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const inputIsJson = ext === "json" || req.file.mimetype === "application/json";
    let output;

    if (format === "json") {
      if (inputIsJson) {
        output = JSON.stringify(JSON.parse(stripBom(input)), null, req.body.pretty === "false" ? 0 : 2);
      } else {
        output = csvToJson(input, {
          delimiter: req.body.inputDelimiter || req.body.delimiter,
          columns: req.body.columns !== "false",
          typed: req.body.typed !== "false",
          pretty: req.body.pretty !== "false",
        });
      }
    } else {
      if (inputIsJson) {
        output = jsonToCsv(input, {
          delimiter: req.body.outputDelimiter || req.body.delimiter,
          flatten: req.body.flatten !== "false",
        });
      } else {
        const json = csvToJson(input, {
          delimiter: req.body.inputDelimiter || req.body.delimiter,
          columns: req.body.columns !== "false",
          typed: false,
          pretty: false,
        });
        output = jsonToCsv(json, {
          delimiter: req.body.outputDelimiter || req.body.delimiter,
          flatten: false,
        });
      }
    }

    const buffer = Buffer.from(output, "utf8");
    saveBufferResult(res, buffer, req.file.originalname, format, "data", req.file.size);
  } catch (err) {
    console.error("[DATA] Error:", err.message);
    logError("conversion", err.message, { type: "data" });
    res.status(400).json({ error: "Erreur de conversion: " + err.message });
  } finally {
    cleanup(req.file.path);
  }
});

// ===== DOWNLOAD =====
app.get("/api/preview/:filename", (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier introuvable" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(filePath);
});

app.get("/api/download/:filename", (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier introuvable" });
  }
  const downloadName = req.query.name || filename;
  res.download(filePath, downloadName, (err) => {
    // Cleanup after download (delay to allow completion)
    setTimeout(() => cleanup(filePath), 5000);
  });
});

// ===== ADMIN CHECK =====
app.post("/api/admin/check", (req, res) => {
  if (matchesAdminCode(req.body.code)) {
    res.json({ ok: true });
  } else {
    res.status(403).json({ error: "Code invalide" });
  }
});

// ===== STATUS =====
app.get("/api/status", (req, res) => {
  res.json({
    videoJobs: activeVideoJobs,
    maxVideoJobs: MAX_VIDEO_JOBS,
    audioJobs: activeAudioJobs,
    maxAudioJobs: MAX_AUDIO_JOBS,
    maxImageSize: humanSize(MAX_IMAGE_SIZE),
    maxPdfSize: humanSize(MAX_PDF_SIZE),
    maxDataSize: humanSize(MAX_DATA_SIZE),
    maxAudioSize: humanSize(MAX_AUDIO_SIZE),
    maxVideoSize: humanSize(MAX_VIDEO_SIZE),
  });
});

app.get("/api/stats", (req, res) => {
  res.json({ cumulative: stats });
});

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}


// ===== ERROR LOGGING =====
const ERRORS_FILE = path.join(RUNTIME_DIR, "errors.json");
let errorLogs = [];
if (fs.existsSync(ERRORS_FILE)) {
  try { errorLogs = JSON.parse(fs.readFileSync(ERRORS_FILE, "utf-8")); } catch {}
}

function logError(type, error, extra) {
  const entry = { time: new Date().toISOString(), type, error: typeof error === "string" ? error.substring(0, 500) : String(error).substring(0, 500), ...extra };
  errorLogs.push(entry);
  if (errorLogs.length > 500) errorLogs = errorLogs.slice(-500);
  try {
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(errorLogs, null, 2), { mode: 0o600 });
    fs.chmodSync(ERRORS_FILE, 0o600);
  } catch {}
  console.log("[ERROR-LOG] " + type + " — " + entry.error.substring(0, 100));
}

app.post("/api/report-bug", (req, res) => {
  const { error, comment, userAgent, page } = req.body || {};
  logError("user-report", error || "No error message", {
    comment: String(comment || "").slice(0, 500),
    page: String(page || "/").slice(0, 200),
    userAgent: String(userAgent || req.headers["user-agent"] || "").slice(0, 500),
    ip: req.ip,
  });
  res.json({ ok: true });
});

app.get("/api/errors", requireErrorsToken, (req, res) => { res.json(errorLogs.slice(-100).reverse()); });
// ===== 404 CATCH-ALL =====
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ===== GLOBAL ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.message);
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FIELD_VALUE";
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "Fichier trop volumineux" : "Formulaire de conversion invalide",
    });
  }
  res.status(500).json({ error: "Erreur interne du serveur" });
});


function start() {
  return app.listen(PORT, HOST, () => {
    console.log(`Converter running on http://${HOST}:${PORT}`);
    console.log(`Max image: ${humanSize(MAX_IMAGE_SIZE)}, Max pdf: ${humanSize(MAX_PDF_SIZE)}, Max data: ${humanSize(MAX_DATA_SIZE)}, Max audio: ${humanSize(MAX_AUDIO_SIZE)}, Max video: ${humanSize(MAX_VIDEO_SIZE)}`);

    // Check if ffmpeg is available
    ffmpeg.getAvailableFormats((err) => {
      if (err) console.warn("⚠ ffmpeg not found — video conversion disabled");
      else console.log("ffmpeg detected — video conversion enabled");
    });
  });
}

if (require.main === module) start();

module.exports = { app, start };
