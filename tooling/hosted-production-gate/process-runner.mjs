import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { HostedGateRefusal } from "./contract.mjs";

const executeFile = promisify(execFile);

export const MINIMAL_ENVIRONMENT = Object.freeze({
  DEBIAN_FRONTEND: "noninteractive",
  HOME: "/root",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TZ: "UTC",
});

function validate(executable, arguments_, options) {
  if (!isAbsolute(executable) || executable.includes("\0"))
    throw new HostedGateRefusal("host_command_path_invalid");
  if (
    !Array.isArray(arguments_) ||
    arguments_.length > 256 ||
    arguments_.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        argument.length > 16_384,
    )
  )
    throw new HostedGateRefusal("host_command_arguments_invalid");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 4 * 60 * 60_000 ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1 ||
    options.maxOutputBytes > 16 * 1024 * 1024
  )
    throw new HostedGateRefusal("host_command_limits_invalid");
}

export async function runCommand(
  executable,
  arguments_,
  {
    environment = {},
    maxOutputBytes = 4 * 1024 * 1024,
    timeoutMs = 120_000,
  } = {},
) {
  const options = { maxOutputBytes, timeoutMs };
  validate(executable, arguments_, options);
  if (
    Object.entries(environment).some(
      ([name, value]) =>
        !/^[A-Z][A-Z0-9_]*$/u.test(name) ||
        typeof value !== "string" ||
        /[\0\r\n]/u.test(value),
    )
  )
    throw new HostedGateRefusal("host_command_environment_invalid");
  try {
    const result = await executeFile(executable, [...arguments_], {
      encoding: "utf8",
      env: { ...MINIMAL_ENVIRONMENT, ...environment },
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return Object.freeze({
      code: 0,
      stderr: result.stderr,
      stdout: result.stdout,
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

export async function requireCommand(executable, arguments_, code, options) {
  const result = await runCommand(executable, arguments_, options);
  if (result.code !== 0) throw new HostedGateRefusal(code);
  return result.stdout;
}
