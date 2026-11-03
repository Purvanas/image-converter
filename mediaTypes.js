const path = require("path");

const MEDIA_TYPES = {
  image: {
    formats: ["jpeg", "png", "webp", "avif", "tiff", "pdf"],
    defaultFormat: "webp",
    extensions: ["jpg", "jpeg", "png", "webp", "avif", "tif", "tiff", "gif", "bmp", "svg", "heic", "heif"],
    mimePrefixes: ["image/"],
    mimes: ["image/svg+xml", "image/heic", "image/heif"],
  },
  video: {
    formats: ["mp4", "webm", "gif"],
    defaultFormat: "mp4",
    extensions: ["mp4", "webm", "mkv", "avi", "mov", "flv", "ogv", "3gp", "m4v"],
    mimePrefixes: ["video/"],
    mimes: [],
  },
  audio: {
    formats: ["mp3", "wav", "ogg", "opus", "flac", "aac", "m4a", "wma"],
    defaultFormat: "mp3",
    extensions: ["mp3", "wav", "ogg", "oga", "opus", "flac", "aac", "m4a", "wma", "weba", "aiff", "aif", "alac"],
    mimePrefixes: ["audio/"],
    mimes: ["application/ogg", "application/x-ms-wma"],
  },
  pdf: {
    formats: ["png", "jpg"],
    defaultFormat: "png",
    extensions: ["pdf"],
    mimePrefixes: [],
    mimes: ["application/pdf"],
  },
  data: {
    formats: ["csv", "json"],
    defaultFormat: "csv",
    extensions: ["csv", "json"],
    mimePrefixes: ["text/csv"],
    mimes: ["application/json", "text/json", "text/csv", "application/csv"],
  },
};

function getExtension(file) {
  return path.extname(file?.originalname || file?.name || "").slice(1).toLowerCase();
}

function getMime(file) {
  return (file?.mimetype || file?.type || "").toLowerCase();
}

function getMediaKind(file) {
  const ext = getExtension(file);
  const mime = getMime(file);

  for (const [kind, config] of Object.entries(MEDIA_TYPES)) {
    if (mime && (config.mimes.includes(mime) || config.mimePrefixes.some((prefix) => mime.startsWith(prefix)))) {
      return kind;
    }
    if (ext && config.extensions.includes(ext)) {
      return kind;
    }
  }

  return null;
}

function getOutputFormats(kind) {
  return MEDIA_TYPES[kind]?.formats || [];
}

function getDefaultOutputFormat(kind) {
  return MEDIA_TYPES[kind]?.defaultFormat || null;
}

module.exports = {
  MEDIA_TYPES,
  getMediaKind,
  getOutputFormats,
  getDefaultOutputFormat,
};
