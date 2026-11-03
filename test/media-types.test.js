const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMediaKind,
  getOutputFormats,
  getDefaultOutputFormat,
} = require("../mediaTypes");

test("detects media kind from common file extensions when mime type is missing or misleading", () => {
  assert.equal(getMediaKind({ originalname: "photo.webp", mimetype: "" }), "image");
  assert.equal(getMediaKind({ originalname: "iphone.HEIC", mimetype: "application/octet-stream" }), "image");
  assert.equal(getMediaKind({ originalname: "clip.MOV", mimetype: "application/octet-stream" }), "video");
  assert.equal(getMediaKind({ originalname: "voice.wma", mimetype: "application/octet-stream" }), "audio");
});

test("detects audio from mime type", () => {
  assert.equal(getMediaKind({ originalname: "download", mimetype: "audio/mpeg" }), "audio");
  assert.equal(getMediaKind({ originalname: "download", mimetype: "audio/x-ms-wma" }), "audio");
});

test("treats plain ogg extension as audio unless mime type says video", () => {
  assert.equal(getMediaKind({ originalname: "song.ogg", mimetype: "application/octet-stream" }), "audio");
  assert.equal(getMediaKind({ originalname: "movie.ogg", mimetype: "video/ogg" }), "video");
});

test("returns output formats and default format for each media kind", () => {
  assert.deepEqual(getOutputFormats("image"), ["jpeg", "png", "webp", "avif", "tiff", "pdf"]);
  assert.deepEqual(getOutputFormats("video"), ["mp4", "webm", "gif"]);
  assert.deepEqual(getOutputFormats("audio"), ["mp3", "wav", "ogg", "opus", "flac", "aac", "m4a", "wma"]);
  assert.deepEqual(getOutputFormats("pdf"), ["png", "jpg"]);
  assert.deepEqual(getOutputFormats("data"), ["csv", "json"]);
  assert.equal(getDefaultOutputFormat("audio"), "mp3");
});

test("detects pdf and data files", () => {
  assert.equal(getMediaKind({ originalname: "document.pdf", mimetype: "application/pdf" }), "pdf");
  assert.equal(getMediaKind({ originalname: "rows.csv", mimetype: "text/csv" }), "data");
  assert.equal(getMediaKind({ originalname: "payload.json", mimetype: "application/json" }), "data");
});

test("returns null for unsupported files", () => {
  assert.equal(getMediaKind({ originalname: "archive.zip", mimetype: "application/zip" }), null);
});
