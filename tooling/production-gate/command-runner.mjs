import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
} from "node:child_process";
import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { promisify } from "node:util";

import {
  HOST_COMMAND_LIMITS,
  MINIMAL_COMMAND_ENVIRONMENT,
} from "./constants.mjs";

const defaultExecFile = promisify(nodeExecFile);

function validateInvocation(executable, args, limits) {
  if (!isAbsolute(executable) || executable.includes("\u0000"))
    throw new Error("gate_executable_must_be_absolute");
  if (
    !Array.isArray(args) ||
    args.length > 256 ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 16_384 ||
        argument.includes("\u0000"),
    )
  )
    throw new Error("unsafe_gate_command_arguments");
  if (
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    limits.timeoutMs > 120_000 ||
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes < 1 ||
    limits.maxOutputBytes > 4 * 1024 * 1024
  )
    throw new Error("unsafe_gate_command_limits");
}

function commandEnvironment(environment) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.entries(environment).some(
      ([name, value]) =>
        !/^[A-Z][A-Z0-9_]*$/u.test(name) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        value.includes("\n") ||
        value.includes("\r"),
    ) ||
    Object.keys(MINIMAL_COMMAND_ENVIRONMENT).some((name) =>
      Object.hasOwn(environment, name),
    )
  )
    throw new Error("unsafe_gate_command_environment");
  return Object.freeze({ ...MINIMAL_COMMAND_ENVIRONMENT, ...environment });
}

export class BoundedCommandRunner {
  constructor({
    executeFile = defaultExecFile,
    reviewedExecutables,
    spawn = nodeSpawn,
  } = {}) {
    this.executeFile = executeFile;
    this.reviewedExecutables = reviewedExecutables;
    this.spawnProcess = spawn;
  }

  async run(
    executable,
    args,
    { environment = {}, maxOutputBytes, timeoutMs } = HOST_COMMAND_LIMITS,
  ) {
    const limits = {
      maxOutputBytes: maxOutputBytes ?? HOST_COMMAND_LIMITS.maxOutputBytes,
      timeoutMs: timeoutMs ?? HOST_COMMAND_LIMITS.timeoutMs,
    };
    validateInvocation(executable, args, limits);
    await this.reviewedExecutables?.assertUnchanged(executable);
    const options = {
      encoding: "utf8",
      env: commandEnvironment(environment),
      killSignal: "SIGKILL",
      maxBuffer: limits.maxOutputBytes,
      shell: false,
      timeout: limits.timeoutMs,
      windowsHide: true,
    };
    try {
      const result = await this.executeFile(executable, [...args], options);
      return Object.freeze({
        code: 0,
        stderr: result.stderr ?? "",
        stdout: result.stdout ?? "",
      });
    } catch (error) {
      return Object.freeze({
        code: Number.isSafeInteger(error?.code) ? error.code : null,
        errorCode:
          typeof error?.code === "string"
            ? error.code
            : error?.killed === true
              ? "command_timeout"
              : "command_failed",
        stderr: typeof error?.stderr === "string" ? error.stderr : "",
        stdout: typeof error?.stdout === "string" ? error.stdout : "",
      });
    }
  }

  async start(executable, args, { environment = {}, timeoutMs = 30_000 } = {}) {
    const limits = {
      maxOutputBytes: HOST_COMMAND_LIMITS.maxOutputBytes,
      timeoutMs,
    };
    validateInvocation(executable, args, limits);
    await this.reviewedExecutables?.assertUnchanged(executable);
    const child = this.spawnProcess(executable, [...args], {
      env: commandEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    const completion = new Promise((resolve) => {
      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      const capture = (target, chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > limits.maxOutputBytes) child.kill("SIGKILL");
        else target.push(chunk);
      };
      child.stdout?.on("data", (chunk) => capture(stdout, chunk));
      child.stderr?.on("data", (chunk) => capture(stderr, chunk));
      child.once("exit", (code, signal) => {
        settled = true;
        resolve({
          code,
          signal,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
      child.once("error", (error) => {
        settled = true;
        resolve({
          code: null,
          errorCode: error.message,
          stderr: "",
          stdout: "",
        });
      });
    });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    return Object.freeze({
      completion: completion.finally(() => clearTimeout(timer)),
      kill: () => child.kill("SIGKILL"),
      pid: child.pid,
    });
  }
}
