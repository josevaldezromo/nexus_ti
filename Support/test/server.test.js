"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseDate, validText } = require("../server");

test("parseDate only accepts real calendar dates in ISO format", () => {
  assert.equal(parseDate("2028-02-29"), "2028-02-29");
  assert.equal(parseDate("2027-02-29"), null);
  assert.equal(parseDate("2027-13-01"), null);
  assert.equal(parseDate("01/02/2027"), null);
  assert.equal(parseDate(null), null);
});

test("validText trims values and enforces required and maximum length", () => {
  assert.equal(validText("  solicitud  ", 12), "solicitud");
  assert.equal(validText("  ", 12), null);
  assert.equal(validText("descripción", 4), null);
  assert.equal(validText("", 12, false), "");
  assert.equal(validText(null, 12, false), null);
});
