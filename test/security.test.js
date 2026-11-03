"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("admin fails closed and error logs require their bearer token", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "converter-test-"));
  delete process.env.ADMIN_CODE;
  process.env.ERRORS_TOKEN = "test-only-token";
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
  const base = `http://127.0.0.1:${port}`;
  const admin = await fetch(`${base}/api/admin/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "anything" }),
  });
  assert.equal(admin.status, 403);

  const errors = await fetch(`${base}/api/errors`);
  assert.equal(errors.status, 404);

  const authorized = await fetch(`${base}/api/errors`, {
    headers: { authorization: "Bearer test-only-token" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), []);
});
