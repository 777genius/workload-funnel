import { PINNED_IMAGES } from "./constants.mjs";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_DIGEST = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

function refuse(condition) {
  if (condition) throw new Error("docker_image_inventory_malformed");
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizedStrings(value, validator = () => true) {
  refuse(
    !Array.isArray(value) ||
      value.length > 256 ||
      value.some(
        (item) =>
          typeof item !== "string" ||
          item.length < 1 ||
          item.length > 4096 ||
          hasControlCharacter(item) ||
          !validator(item),
      ),
  );
  const normalized = [...new Set(value)].sort();
  refuse(normalized.length !== value.length);
  return Object.freeze(normalized);
}

export function normalizeDockerImageInventory(value) {
  refuse(!Array.isArray(value) || value.length > 256);
  const normalized = value.map((item) => {
    refuse(
      item === null ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).length !== 4 ||
        !Object.hasOwn(item, "id") ||
        !Object.hasOwn(item, "repoDigests") ||
        !Object.hasOwn(item, "repoTags") ||
        !Object.hasOwn(item, "size") ||
        !IMAGE_ID.test(item.id ?? "") ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0,
    );
    return Object.freeze({
      id: item.id,
      repoDigests: normalizedStrings(item.repoDigests, (entry) =>
        REPOSITORY_DIGEST.test(entry),
      ),
      repoTags: normalizedStrings(item.repoTags),
      size: item.size,
    });
  });
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  refuse(
    normalized.some(
      (item, index) => index > 0 && item.id === normalized[index - 1].id,
    ),
  );
  return Object.freeze(normalized);
}

export function pinnedImageReferenceCollisions(value) {
  const inventory = normalizeDockerImageInventory(value);
  const expectedTags = new Set();
  const expectedDigests = new Set();
  for (const reference of Object.values(PINNED_IMAGES)) {
    const separator = reference.indexOf("@");
    const digest = reference.match(/@sha256:([a-f0-9]{64})$/u)?.[1];
    refuse(separator < 1 || digest === undefined);
    expectedTags.add(reference.slice(0, separator));
    expectedDigests.add(digest);
  }
  return Object.freeze(
    inventory
      .filter(
        (item) =>
          item.repoTags.some((tag) => expectedTags.has(tag)) ||
          item.repoDigests.some((digest) =>
            expectedDigests.has(digest.slice(-64)),
          ),
      )
      .map((item) => item.id),
  );
}
