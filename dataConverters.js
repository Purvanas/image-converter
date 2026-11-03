const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");

function normalizeDelimiter(value) {
  const key = String(value || ",").toLowerCase();
  if (key === "comma") return ",";
  if (key === "semicolon") return ";";
  if (key === "tab") return "\t";
  if (key === "pipe") return "|";
  if ([",", ";", "\t", "|"].includes(value)) return value;
  return ",";
}

function stripBom(input) {
  return String(input || "").replace(/^\uFEFF/, "");
}

function coerceValue(value) {
  if (value === "") return "";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function csvToJson(input, options = {}) {
  const records = parse(input, {
    bom: true,
    columns: options.columns !== false,
    delimiter: normalizeDelimiter(options.delimiter),
    skip_empty_lines: true,
    trim: options.trim !== false,
    relax_column_count: !!options.relaxColumnCount,
  });

  const output = options.typed
    ? records.map((row) => {
        if (Array.isArray(row)) return row.map(coerceValue);
        return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, coerceValue(value)]));
      })
    : records;

  return JSON.stringify(output, null, options.pretty === false ? 0 : 2);
}

function flattenObject(value, prefix = "", output = {}) {
  for (const [key, child] of Object.entries(value || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      output[nextKey] = child.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : item)).join(",");
    } else if (child && typeof child === "object") {
      flattenObject(child, nextKey, output);
    } else {
      output[nextKey] = child;
    }
  }
  return output;
}

function jsonToRows(input, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(input));
  } catch (err) {
    throw new Error(`JSON invalide: ${err.message}`);
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("Le JSON doit etre un objet ou un tableau d'objets");
  }

  return options.flatten === false ? rows : rows.map((row) => flattenObject(row));
}

function jsonToCsv(input, options = {}) {
  const rows = jsonToRows(input, options);
  return stringify(rows, {
    header: true,
    delimiter: normalizeDelimiter(options.delimiter),
  });
}

module.exports = {
  csvToJson,
  jsonToCsv,
  jsonToRows,
  normalizeDelimiter,
  stripBom,
  flattenObject,
};
