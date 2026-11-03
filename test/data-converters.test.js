const test = require("node:test");
const assert = require("node:assert/strict");

const {
  csvToJson,
  jsonToCsv,
  normalizeDelimiter,
  flattenObject,
} = require("../dataConverters");

test("converts semicolon csv to typed json objects", () => {
  const output = csvToJson("name;age\nAda;37\nLinus;55\n", {
    delimiter: ";",
    columns: true,
    typed: true,
    pretty: false,
  });

  assert.equal(output, '[{"name":"Ada","age":37},{"name":"Linus","age":55}]');
});

test("converts nested json array to csv with dot-notated columns", () => {
  const output = jsonToCsv('[{"user":{"name":"Ada"},"score":3},{"user":{"name":"Linus"},"score":5}]', {
    delimiter: ",",
    flatten: true,
  });

  assert.equal(output.trim(), "user.name,score\nAda,3\nLinus,5");
});

test("accepts json files that start with a UTF-8 BOM", () => {
  const output = jsonToCsv('\uFEFF[{"name":"Ada"}]', {
    delimiter: ",",
    flatten: true,
  });

  assert.equal(output.trim(), "name\nAda");
});

test("normalizes common delimiter names", () => {
  assert.equal(normalizeDelimiter("semicolon"), ";");
  assert.equal(normalizeDelimiter("tab"), "\t");
  assert.equal(normalizeDelimiter("|"), "|");
});

test("flattens arrays and nested objects predictably", () => {
  assert.deepEqual(flattenObject({ a: { b: 1 }, tags: ["x", "y"] }), {
    "a.b": 1,
    tags: "x,y",
  });
});
