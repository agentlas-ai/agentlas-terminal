"use strict";

const SEMVER_RE = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemVer(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(SEMVER_RE);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
    build: match[5] ? match[5].split(".") : [],
  };
}

function normalizeSemVer(value) {
  const parsed = parseSemVer(value);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}` +
    `${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}` +
    `${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`;
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** SemVer 2.0.0 precedence. Build metadata is intentionally ignored. */
function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    const compared = compareNumericIdentifier(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

module.exports = { parseSemVer, normalizeSemVer, compareSemVer };
