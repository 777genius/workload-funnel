import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

function assertRequest(request) {
  if (
    !isAbsolute(request.executable) ||
    !isAbsolute(request.cwd) ||
    !Array.isArray(request.argv) ||
    request.argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 64 * 1024 ||
        value.includes("\0"),
    ) ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 15 * 60_000 ||
    typeof request.expectedExecutableIdentity !== "object" ||
    request.expectedExecutableIdentity === null ||
    !Number.isSafeInteger(request.expectedExecutableIdentity.device) ||
    !Number.isSafeInteger(request.expectedExecutableIdentity.inode) ||
    !Number.isFinite(request.expectedExecutableIdentity.modifiedMs) ||
    !Number.isSafeInteger(request.expectedExecutableIdentity.size) ||
    !/^[a-f0-9]{64}$/u.test(request.expectedExecutableIdentity.sha256)
  ) {
    throw new Error("hosted_canary_process_request_invalid");
  }
}

function assertSafeExecutableAncestors(path) {
  let current = dirname(path);
  for (;;) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(current) !== current ||
      ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) ||
      (process.getuid !== undefined &&
        metadata.uid !== process.getuid() &&
        metadata.uid !== 0)
    )
      throw new Error("hosted_canary_executable_ancestor_unsafe");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function collect(child, request, includeOutput = true) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputExceeded = false;
    let outputBytes = 0;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, request.timeoutMs);
    const append = (current, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes) {
        outputExceeded = true;
        killProcessGroup(child);
        return Buffer.alloc(0);
      }
      return Buffer.concat([current, chunk]);
    };
    const collectStream = (stream, save) =>
      new Promise((resolveStream) => {
        if (stream === null) {
          resolveStream();
          return;
        }
        stream.on("data", (chunk) => save(Buffer.from(chunk)));
        stream.once("end", resolveStream);
        stream.once("error", () => {
          outputExceeded = true;
          killProcessGroup(child);
          resolveStream();
        });
      });
    const streams = Promise.all([
      collectStream(child.stdout, (chunk) => {
        stdout = append(stdout, chunk);
      }),
      collectStream(child.stderr, (chunk) => {
        stderr = append(stderr, chunk);
      }),
    ]);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("hosted_canary_process_spawn_failed"));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      killProcessGroup(child);
      void streams.then(() =>
        resolve(
          Object.freeze({
            exitCode,
            ...(includeOutput
              ? {
                  stderr: outputExceeded ? "" : stderr.toString("utf8"),
                  stdout: outputExceeded ? "" : stdout.toString("utf8"),
                }
              : {}),
            timedOut: timedOut || outputExceeded,
          }),
        ),
      );
    });
  });
}

function killProcessGroup(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      child.kill("SIGKILL");
  }
}

function launch(request, captureOutput) {
  assertRequest(request);
  assertSafeExecutableAncestors(request.executable);
  const actual = lstatSync(request.executable);
  const expected = request.expectedExecutableIdentity;
  if (
    actual.dev !== expected.device ||
    actual.ino !== expected.inode ||
    actual.mtimeMs !== expected.modifiedMs ||
    actual.size !== expected.size
  )
    throw new Error("hosted_canary_executable_changed_before_spawn");
  return spawn(request.executable, [...request.argv], {
    cwd: request.cwd,
    detached: true,
    env: { ...request.environment },
    shell: false,
    stdio: captureOutput
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
}

export function createNodeHostedCanaryProcessRunner() {
  return Object.freeze({
    async inspectExecutable(path) {
      if (!isAbsolute(path))
        throw new Error("hosted_canary_executable_path_invalid");
      assertSafeExecutableAncestors(path);
      const [identity, canonical] = await Promise.all([
        lstat(path),
        realpath(path),
      ]);
      const parent = dirname(path);
      const parentIdentity = lstatSync(parent);
      if (
        canonical !== path ||
        realpathSync(parent) !== parent ||
        !parentIdentity.isDirectory() ||
        parentIdentity.isSymbolicLink() ||
        (parentIdentity.mode & 0o022) !== 0 ||
        (process.getuid !== undefined &&
          parentIdentity.uid !== process.getuid() &&
          parentIdentity.uid !== 0) ||
        !identity.isFile() ||
        identity.isSymbolicLink() ||
        (identity.mode & 0o022) !== 0 ||
        (identity.mode & 0o111) === 0 ||
        identity.size < 1 ||
        identity.size > 256 * 1024 * 1024 ||
        (process.getuid !== undefined &&
          identity.uid !== process.getuid() &&
          identity.uid !== 0)
      ) {
        throw new Error("hosted_canary_executable_identity_unsafe");
      }
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (
        after.dev !== identity.dev ||
        after.ino !== identity.ino ||
        after.mtimeMs !== identity.mtimeMs ||
        after.size !== identity.size
      )
        throw new Error("hosted_canary_executable_changed_during_hash");
      return Object.freeze({
        device: identity.dev,
        inode: identity.ino,
        modifiedMs: identity.mtimeMs,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: identity.size,
      });
    },
    run(request) {
      const child = launch(request, true);
      return collect(child, request);
    },
    startForeground(request) {
      // Foreground provider output can contain secrets. Ownership evidence is
      // limited to bounded process completion, so no child bytes are captured.
      const child = launch(request, false);
      const completion = collect(child, request, false);
      return new Promise((resolve, reject) => {
        child.once("error", () => {
          void completion.catch(() => undefined);
          reject(new Error("hosted_canary_foreground_spawn_failed"));
        });
        child.once("spawn", () =>
          resolve(
            Object.freeze({
              completion,
              terminate: () => killProcessGroup(child),
            }),
          ),
        );
      });
    },
  });
}
