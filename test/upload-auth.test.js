"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("admin upload limit is selected from a verified pre-multipart header", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "converter-upload-test-"));
  process.env.ADMIN_CODE = "test-admin-code";
  process.env.PUBLIC_UPLOAD_MAX_BYTES = "64";
  process.env.ADMIN_UPLOAD_MAX_BYTES = "1024";
  process.env.RUNTIME_DIR = runtime;

  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/convert/data`;
  const source = JSON.stringify({ value: "x".repeat(128) });
  const form = () => {
    const body = new FormData();
    body.append("adminCode", "test-admin-code");
    body.append("file", new Blob([source], { type: "application/json" }), "sample.json");
    body.append("format", "csv");
    return body;
  };

  const bodyOnly = await fetch(endpoint, { method: "POST", body: form() });
  assert.equal(bodyOnly.status, 413, "a multipart field must not raise the pre-upload limit");

  const wrongHeader = await fetch(endpoint, {
    method: "POST",
    headers: { "x-admin-code": "wrong" },
    body: form(),
  });
  assert.equal(wrongHeader.status, 413);

  const verifiedHeader = await fetch(endpoint, {
    method: "POST",
    headers: { "x-admin-code": "test-admin-code" },
    body: form(),
  });
  assert.equal(verifiedHeader.status, 200);
  const result = await verifiedHeader.json();
  assert.match(result.downloadUrl, /^\/api\/download\//);
});
