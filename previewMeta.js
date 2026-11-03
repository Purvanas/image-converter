const PREVIEW_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  document: 8 * 1024 * 1024,
  text: 512 * 1024,
};

const FORMAT_KIND = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  avif: "image",
  gif: "image",
  mp4: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  opus: "audio",
  flac: "audio",
  aac: "audio",
  m4a: "audio",
  wma: "audio",
  pdf: "document",
  csv: "text",
  json: "text",
};

function buildPreviewMeta(filename, format, sizeBytes) {
  const normalizedFormat = String(format || "").toLowerCase();
  const kind = FORMAT_KIND[normalizedFormat];
  if (!kind) return null;

  const safeName = String(filename || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeName) return null;

  return {
    url: `/api/preview/${safeName}`,
    kind,
    auto: sizeBytes <= PREVIEW_LIMITS[kind],
    sizeBytes,
  };
}

module.exports = {
  PREVIEW_LIMITS,
  FORMAT_KIND,
  buildPreviewMeta,
};
