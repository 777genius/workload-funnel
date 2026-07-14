import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const DISPOSABLE_SENTINEL_FILE =
  ".workload-funnel-disposable-canary.json";
export const DISPOSABLE_SENTINEL_PURPOSE =
  "WORKLOAD_FUNNEL_SUBSCRIPTION_RUNTIME_DISPOSABLE_CANARY_ONLY";
export const CANARY_GOAL_SENTINEL = "WORKLOAD_FUNNEL_HOSTED_CANARY_ONLY";
export const CANARY_EXPECTED_ARTIFACT_FILE = "hosted-canary-result.txt";
export const CANARY_EXPECTED_ARTIFACT_CONTENT =
  "WORKLOAD_FUNNEL_HOSTED_CANARY_COMPLETED\n";
export const CANARY_GOAL_PROMPT = `${CANARY_GOAL_SENTINEL}

Create exactly one new file named ${CANARY_EXPECTED_ARTIFACT_FILE} in the workspace root.
Its complete contents must be exactly this single line:
WORKLOAD_FUNNEL_HOSTED_CANARY_COMPLETED
Do not modify or create any other workspace file. Do not run git add, git commit, or git push.
Finish after writing the file.`;
const PRIVATE_ROOT_MARKER = "ownership.json";

function exactKeys(value, expected, code) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  )
    throw new Error(code);
}

async function boundedJson(path, maximumBytes, code, ownerUid) {
  try {
    return JSON.parse(
      await boundedContents(path, maximumBytes, 2, code, ownerUid),
    );
  } catch {
    throw new Error(code);
  }
}

async function boundedText(path, maximumBytes, code, ownerUid) {
  return boundedContents(path, maximumBytes, 1, code, ownerUid);
}

async function boundedContents(
  path,
  maximumBytes,
  minimumBytes,
  code,
  ownerUid,
) {
  const handle = await open(
    path,
    constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < minimumBytes ||
      metadata.size > maximumBytes ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.uid !== ownerUid
    )
      throw new Error(code);
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.size !== metadata.size ||
      Buffer.byteLength(contents, "utf8") !== metadata.size
    )
      throw new Error(code);
    return contents;
  } finally {
    await handle.close();
  }
}

async function assertOwnedGitDirectory(path, gitRoot, ownerUid) {
  const [metadata, canonical] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid ||
    (metadata.mode & 0o022) !== 0 ||
    !canonical.startsWith(`${gitRoot}/`)
  )
    throw new Error("hosted_canary_disposable_git_root_invalid");
}

async function assertFreshGitRoot(root, ownerUid) {
  const gitRoot = join(root, ".git");
  const git = await lstat(gitRoot);
  if (
    !git.isDirectory() ||
    git.isSymbolicLink() ||
    (git.mode & 0o022) !== 0 ||
    git.uid !== ownerUid
  )
    throw new Error("hosted_canary_disposable_git_root_invalid");
  const configPath = join(gitRoot, "config");
  const configMetadata = await lstat(configPath);
  if (
    !configMetadata.isFile() ||
    configMetadata.isSymbolicLink() ||
    configMetadata.size > 64 * 1024 ||
    (configMetadata.mode & 0o022) !== 0 ||
    configMetadata.uid !== ownerUid
  )
    throw new Error("hosted_canary_disposable_git_root_invalid");
  const config = await readFile(configPath, "utf8");
  if (
    /^\s*\[(?!core\])/imu.test(config) ||
    /^\s*bare\s*=\s*true\s*$/imu.test(config) ||
    /^\s*(?:hooksPath|worktree)\s*=/imu.test(config)
  )
    throw new Error("hosted_canary_git_remote_forbidden");
  assertInertGitConfig(config);
  const topLevel = await readdir(gitRoot);
  const allowed = new Set([
    "HEAD",
    "branches",
    "config",
    "description",
    "hooks",
    "info",
    "objects",
    "refs",
  ]);
  if (
    ["HEAD", "objects", "refs"].some((entry) => !topLevel.includes(entry)) ||
    topLevel.some((entry) => !allowed.has(entry))
  )
    throw new Error("hosted_canary_git_history_forbidden");
  const headPath = join(gitRoot, "HEAD");
  const headMetadata = await lstat(headPath);
  const head = await readFile(headPath, "utf8");
  if (
    !headMetadata.isFile() ||
    headMetadata.isSymbolicLink() ||
    headMetadata.uid !== ownerUid ||
    (headMetadata.mode & 0o022) !== 0 ||
    headMetadata.size > 1_024 ||
    !/^ref: refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*\n?$/u.test(head) ||
    head.includes("..")
  )
    throw new Error("hosted_canary_disposable_git_root_invalid");
  const objects = join(gitRoot, "objects");
  await assertOwnedGitDirectory(objects, gitRoot, ownerUid);
  const objectEntries = await readdir(objects);
  if (objectEntries.some((entry) => !["info", "pack"].includes(entry)))
    throw new Error("hosted_canary_git_history_forbidden");
  for (const entry of objectEntries) {
    await assertOwnedGitDirectory(join(objects, entry), gitRoot, ownerUid);
    if ((await readdir(join(objects, entry))).length !== 0)
      throw new Error("hosted_canary_git_history_forbidden");
  }
  const refs = join(gitRoot, "refs");
  await assertOwnedGitDirectory(refs, gitRoot, ownerUid);
  const refEntries = await readdir(refs);
  if (refEntries.some((entry) => !["heads", "tags"].includes(entry)))
    throw new Error("hosted_canary_git_history_forbidden");
  for (const entry of refEntries) {
    await assertOwnedGitDirectory(join(refs, entry), gitRoot, ownerUid);
    if ((await readdir(join(refs, entry))).length !== 0)
      throw new Error("hosted_canary_git_history_forbidden");
  }
  for (const directoryName of ["branches", "hooks"]) {
    if (!topLevel.includes(directoryName)) continue;
    const directory = join(gitRoot, directoryName);
    await assertOwnedGitDirectory(directory, gitRoot, ownerUid);
    const entries = await readdir(directory);
    if (
      (directoryName === "branches" && entries.length !== 0) ||
      (directoryName === "hooks" &&
        entries.some((entry) => !entry.endsWith(".sample")))
    )
      throw new Error("hosted_canary_disposable_git_root_invalid");
  }
}

function assertInertGitConfig(config) {
  const lines = config
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.shift()?.toLowerCase() !== "[core]")
    throw new Error("hosted_canary_disposable_git_config_invalid");
  const allowed = new Map([
    ["bare", new Set(["false"])],
    ["filemode", new Set(["false", "true"])],
    ["ignorecase", new Set(["false", "true"])],
    ["logallrefupdates", new Set(["true"])],
    ["precomposeunicode", new Set(["false", "true"])],
    ["repositoryformatversion", new Set(["0"])],
  ]);
  const seen = new Set();
  for (const line of lines) {
    const setting = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*([^\s]+)$/u.exec(line);
    const key = setting?.[1]?.toLowerCase();
    const value = setting?.[2]?.toLowerCase();
    if (
      key === undefined ||
      value === undefined ||
      seen.has(key) ||
      !allowed.get(key)?.has(value)
    )
      throw new Error("hosted_canary_disposable_git_config_invalid");
    seen.add(key);
  }
  if (!seen.has("repositoryformatversion"))
    throw new Error("hosted_canary_disposable_git_config_invalid");
}

async function assertPrivateDirectory(path, projectRoot, ownerUid) {
  const [metadata, canonical] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid ||
    (metadata.mode & 0o077) !== 0 ||
    !canonical.startsWith(`${projectRoot}/`)
  )
    throw new Error("hosted_canary_private_root_unsafe");
}

function isMissing(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function ensurePrivateDirectory(path, projectRoot, ownerUid) {
  try {
    await assertPrivateDirectory(path, projectRoot, ownerUid);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { mode: 0o700 });
    await assertPrivateDirectory(path, projectRoot, ownerUid);
  }
}

async function createPrivateMarker(path, marker) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function preparePrivateRoots(projectRoot, ownerUid, nonce) {
  const privateRoot = join(projectRoot, ".workload-funnel-canary");
  const markerPath = join(privateRoot, PRIVATE_ROOT_MARKER);
  let created = false;
  try {
    await assertPrivateDirectory(privateRoot, projectRoot, ownerUid);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(privateRoot, { mode: 0o700 });
    await assertPrivateDirectory(privateRoot, projectRoot, ownerUid);
    created = true;
  }
  const expectedMarker = {
    nonce,
    purpose: DISPOSABLE_SENTINEL_PURPOSE,
    schemaVersion: 1,
  };
  if (created) {
    await createPrivateMarker(markerPath, expectedMarker);
    const directory = await open(privateRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } else {
    const marker = await boundedJson(
      markerPath,
      8 * 1024,
      "hosted_canary_private_root_marker_invalid",
      ownerUid,
    );
    exactKeys(
      marker,
      ["nonce", "purpose", "schemaVersion"],
      "hosted_canary_private_root_marker_invalid",
    );
    if (JSON.stringify(marker) !== JSON.stringify(expectedMarker))
      throw new Error("hosted_canary_private_root_marker_invalid");
  }
  const roots = {
    jobRoot: join(privateRoot, "jobs"),
    registryRoot: join(privateRoot, "registry"),
    stateRoot: join(privateRoot, "state"),
    temporaryRoot: join(privateRoot, "tmp"),
  };
  for (const path of Object.values(roots))
    await ensurePrivateDirectory(path, projectRoot, ownerUid);
  for (const name of ["home", "cache", "config", "data"])
    await ensurePrivateDirectory(
      join(roots.stateRoot, name),
      projectRoot,
      ownerUid,
    );
  return roots;
}

export async function validateDisposableProject(input) {
  const projectRoot = resolve(input.projectRoot);
  const sandboxParent = resolve(input.sandboxParent);
  if (
    !isAbsolute(input.projectRoot) ||
    !isAbsolute(input.sandboxParent) ||
    projectRoot === resolve(input.workspaceRoot) ||
    dirname(projectRoot) !== sandboxParent ||
    !basename(projectRoot).startsWith("workload-funnel-disposable-canary-")
  )
    throw new Error("hosted_canary_project_root_not_disposable");
  const [projectIdentity, canonicalProject, canonicalParent] =
    await Promise.all([
      lstat(projectRoot),
      realpath(projectRoot),
      realpath(sandboxParent),
    ]);
  if (
    canonicalProject !== projectRoot ||
    canonicalParent !== sandboxParent ||
    !projectIdentity.isDirectory() ||
    projectIdentity.isSymbolicLink() ||
    (projectIdentity.mode & 0o022) !== 0 ||
    (process.getuid !== undefined && projectIdentity.uid !== process.getuid())
  )
    throw new Error("hosted_canary_project_root_unsafe");
  const suffix = relative(canonicalParent, canonicalProject);
  if (suffix.startsWith("..") || suffix.includes("/"))
    throw new Error("hosted_canary_project_root_not_direct_child");
  const sentinelPath = join(projectRoot, DISPOSABLE_SENTINEL_FILE);
  const sentinel = await boundedJson(
    sentinelPath,
    8 * 1024,
    "hosted_canary_disposable_sentinel_invalid",
    projectIdentity.uid,
  );
  exactKeys(
    sentinel,
    [
      "createdAtMs",
      "disposable",
      "nonce",
      "productionStartsEnabled",
      "purpose",
      "schemaVersion",
    ],
    "hosted_canary_disposable_sentinel_invalid",
  );
  if (
    sentinel.schemaVersion !== 1 ||
    sentinel.purpose !== DISPOSABLE_SENTINEL_PURPOSE ||
    sentinel.disposable !== true ||
    sentinel.productionStartsEnabled !== false ||
    !Number.isSafeInteger(sentinel.createdAtMs) ||
    sentinel.createdAtMs > input.nowMs + 5 * 60_000 ||
    input.nowMs - sentinel.createdAtMs > input.maximumAgeMs ||
    typeof sentinel.nonce !== "string" ||
    !/^[a-f0-9]{32,128}$/u.test(sentinel.nonce)
  )
    throw new Error("hosted_canary_disposable_sentinel_invalid");
  const requestPath = resolve(input.requestPath);
  if (
    dirname(requestPath) !== projectRoot ||
    basename(requestPath) !== "hosted-canary-request.json"
  )
    throw new Error("hosted_canary_request_must_be_in_project_root");
  const entries = await readdir(projectRoot);
  const promptPath = join(projectRoot, "hosted-canary-prompt.md");
  const allowed = new Set([
    ".git",
    ".workload-funnel-canary",
    DISPOSABLE_SENTINEL_FILE,
    basename(promptPath),
    basename(requestPath),
  ]);
  if (entries.some((entry) => !allowed.has(entry)))
    throw new Error("hosted_canary_project_root_not_fresh");
  await assertFreshGitRoot(projectRoot, projectIdentity.uid);
  const [gitConfig, gitHead] = await Promise.all([
    readFile(join(projectRoot, ".git/config")),
    readFile(join(projectRoot, ".git/HEAD")),
  ]);
  const request = await boundedJson(
    requestPath,
    64 * 1024,
    "hosted_canary_request_invalid",
    projectIdentity.uid,
  );
  exactKeys(
    request,
    ["invocationProfileId", "promptPath", "schemaVersion", "taskId"],
    "hosted_canary_request_invalid",
  );
  if (
    request.schemaVersion !== 1 ||
    typeof request.invocationProfileId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.invocationProfileId) ||
    typeof request.taskId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.taskId) ||
    request.promptPath !== promptPath ||
    (await boundedText(
      promptPath,
      64 * 1024,
      "hosted_canary_prompt_invalid",
      projectIdentity.uid,
    )) !== `${CANARY_GOAL_PROMPT}\n`
  )
    throw new Error("hosted_canary_request_invalid");
  const roots = await preparePrivateRoots(
    projectRoot,
    projectIdentity.uid,
    sentinel.nonce,
  );
  return Object.freeze({
    projectDevice: projectIdentity.dev,
    projectFingerprint: createHash("sha256")
      .update(`${projectIdentity.dev}:${projectIdentity.ino}:${sentinel.nonce}`)
      .digest("hex"),
    gitConfigSha256: createHash("sha256").update(gitConfig).digest("hex"),
    gitHeadSha256: createHash("sha256").update(gitHead).digest("hex"),
    projectInode: projectIdentity.ino,
    projectOwnerUid: projectIdentity.uid,
    projectRoot,
    request: Object.freeze(request),
    sentinel: Object.freeze(sentinel),
    ...roots,
  });
}

export async function verifyNaturalCompletionArtifact(project) {
  const [projectIdentity, canonicalProject] = await Promise.all([
    lstat(project.projectRoot),
    realpath(project.projectRoot),
  ]);
  if (
    !projectIdentity.isDirectory() ||
    projectIdentity.isSymbolicLink() ||
    canonicalProject !== project.projectRoot ||
    projectIdentity.dev !== project.projectDevice ||
    projectIdentity.ino !== project.projectInode ||
    projectIdentity.uid !== project.projectOwnerUid ||
    (projectIdentity.mode & 0o022) !== 0
  )
    throw new Error("hosted_canary_project_identity_changed");
  const entries = await readdir(project.projectRoot);
  const expectedEntries = new Set([
    ".git",
    ".workload-funnel-canary",
    DISPOSABLE_SENTINEL_FILE,
    "hosted-canary-prompt.md",
    "hosted-canary-request.json",
    CANARY_EXPECTED_ARTIFACT_FILE,
  ]);
  if (!entries.includes(CANARY_EXPECTED_ARTIFACT_FILE))
    throw new Error("hosted_canary_expected_artifact_missing");
  if (
    entries.length !== expectedEntries.size ||
    entries.some((entry) => !expectedEntries.has(entry))
  )
    throw new Error("hosted_canary_unexpected_project_change");
  await assertFreshGitRoot(project.projectRoot, projectIdentity.uid);

  const [gitConfig, gitHead] = await Promise.all([
    readFile(join(project.projectRoot, ".git/config")),
    readFile(join(project.projectRoot, ".git/HEAD")),
  ]);
  if (
    createHash("sha256").update(gitConfig).digest("hex") !==
      project.gitConfigSha256 ||
    createHash("sha256").update(gitHead).digest("hex") !== project.gitHeadSha256
  )
    throw new Error("hosted_canary_unexpected_project_change");

  const [sentinel, request, prompt] = await Promise.all([
    boundedJson(
      join(project.projectRoot, DISPOSABLE_SENTINEL_FILE),
      8 * 1024,
      "hosted_canary_unexpected_project_change",
      projectIdentity.uid,
    ),
    boundedJson(
      join(project.projectRoot, "hosted-canary-request.json"),
      64 * 1024,
      "hosted_canary_unexpected_project_change",
      projectIdentity.uid,
    ),
    boundedText(
      join(project.projectRoot, "hosted-canary-prompt.md"),
      64 * 1024,
      "hosted_canary_unexpected_project_change",
      projectIdentity.uid,
    ),
  ]);
  if (
    JSON.stringify(sentinel) !== JSON.stringify(project.sentinel) ||
    JSON.stringify(request) !== JSON.stringify(project.request) ||
    prompt !== `${CANARY_GOAL_PROMPT}\n`
  )
    throw new Error("hosted_canary_unexpected_project_change");

  const artifactPath = join(project.projectRoot, CANARY_EXPECTED_ARTIFACT_FILE);
  let contents;
  try {
    contents = await boundedText(
      artifactPath,
      4 * 1024,
      "hosted_canary_expected_artifact_invalid",
      projectIdentity.uid,
    );
  } catch (error) {
    if (isMissing(error))
      throw new Error("hosted_canary_expected_artifact_missing");
    throw error;
  }
  if (contents !== CANARY_EXPECTED_ARTIFACT_CONTENT)
    throw new Error("hosted_canary_expected_artifact_invalid");
  return Object.freeze({
    path: CANARY_EXPECTED_ARTIFACT_FILE,
    sha256: createHash("sha256").update(contents).digest("hex"),
    verified: true,
  });
}

export function canaryEnvironment(project) {
  return Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(project.stateRoot, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: project.temporaryRoot,
    WORKLOAD_FUNNEL_CANARY_JOB_ROOT: project.jobRoot,
    WORKLOAD_FUNNEL_CANARY_REGISTRY_ROOT: project.registryRoot,
    WORKLOAD_FUNNEL_CANARY_STATE_ROOT: project.stateRoot,
    XDG_CACHE_HOME: join(project.stateRoot, "cache"),
    XDG_CONFIG_HOME: join(project.stateRoot, "config"),
    XDG_DATA_HOME: join(project.stateRoot, "data"),
    XDG_STATE_HOME: project.stateRoot,
  });
}
