const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPreviewMeta } = require("../previewMeta");

test("auto previews small images and gif outputs", () => {
  assert.deepEqual(buildPreviewMeta("out.gif", "gif", 500_000), {
    url: "/api/preview/out.gif",
    kind: "image",
    auto: true,
    sizeBytes: 500_000,
  });
});

test("keeps large video previews on demand", () => {
  assert.deepEqual(buildPreviewMeta("out.mp4", "mp4", 40 * 1024 * 1024), {
    url: "/api/preview/out.mp4",
    kind: "video",
    auto: false,
    sizeBytes: 41943040,
  });
});

test("previews json and csv as text", () => {
  assert.equal(buildPreviewMeta("rows.csv", "csv", 1000).kind, "text");
  assert.equal(buildPreviewMeta("rows.json", "json", 1000).kind, "text");
});

test("does not preview zip archives or unsupported formats", () => {
  assert.equal(buildPreviewMeta("pages.zip", "zip", 1000), null);
  assert.equal(buildPreviewMeta("scan.tiff", "tiff", 1000), null);
});
