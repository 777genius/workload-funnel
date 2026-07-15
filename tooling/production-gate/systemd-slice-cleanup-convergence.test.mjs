import { describe, expect, it, vi } from "vitest";

import { cleanupSystemdSlice } from "./systemd-slice-ledger.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const slice = `${runId}.slice`;
const controlGroup = `/wf.slice/wf-production.slice/wf-production-gate.slice/${slice}`;
const description =
  "Slice /wf/production/gate/0123456789abcdef0123456789abcdef";
const record = {
  expected: { controlGroupSuffix: `/${slice}` },
  name: slice,
  observed: { controlGroup },
};

function result(stdout, code = 0, stderr = "") {
  return { code, stderr, stdout };
}

function sliceShow(overrides = {}) {
  return `${Object.entries({
    ActiveState: "inactive",
    ControlGroup: "",
    Description: description,
    DropInPaths: "",
    FragmentPath: "",
    Id: slice,
    LoadState: "loaded",
    Names: slice,
    SourcePath: "",
    Transient: "no",
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

const activeSlice = () =>
  sliceShow({ ActiveState: "active", ControlGroup: controlGroup });

describe("systemd implicit-slice cleanup convergence", () => {
  it("polls an unchanged active slice until the exact inactive baseline", async () => {
    let shows = 0;
    let now = 0;
    const waits = [];
    const runner = {
      run: vi.fn((_executable, args) => {
        if (args[0] !== "show") return Promise.resolve(result(""));
        shows += 1;
        return Promise.resolve(result(shows < 4 ? activeSlice() : sliceShow()));
      }),
    };
    await expect(
      cleanupSystemdSlice(
        {
          clock: () => now,
          runner,
          systemctlExecutable: "/usr/bin/systemctl",
          wait: (milliseconds) => {
            waits.push(milliseconds);
            now += milliseconds;
            return Promise.resolve();
          },
        },
        record,
      ),
    ).resolves.toBeUndefined();
    expect(waits).toEqual([50, 50]);
    expect(runner.run.mock.calls.map(([, args]) => args[0])).toEqual([
      "show",
      "stop",
      "reset-failed",
      "show",
      "show",
      "show",
    ]);
  });

  it("fails closed when the exact baseline misses the polling bound", async () => {
    let now = 0;
    const runner = {
      run: vi.fn((_executable, args) =>
        Promise.resolve(result(args[0] === "show" ? activeSlice() : "")),
      ),
    };
    await expect(
      cleanupSystemdSlice(
        {
          clock: () => now,
          runner,
          systemctlExecutable: "/usr/bin/systemctl",
          wait: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
          },
        },
        record,
      ),
    ).rejects.toThrow("systemd_slice_cleanup_uncertain");
    expect(now).toBe(1_000);
    expect(runner.run).toHaveBeenCalledTimes(24);
  });

  it.each([
    ["control group", { ControlGroup: `/foreign.slice/${slice}` }],
    ["description", { Description: "foreign" }],
    ["drop-in", { DropInPaths: "/run/systemd/system/foreign.conf" }],
    ["fragment", { FragmentPath: "/run/systemd/system/foreign.slice" }],
    ["source", { SourcePath: "/run/systemd/generator/foreign" }],
    ["transient marker", { Transient: "yes" }],
  ])("fails closed on post-stop %s mutation", async (_, mutation) => {
    let shows = 0;
    const runner = {
      run: vi.fn((_executable, args) => {
        if (args[0] !== "show") return Promise.resolve(result(""));
        shows += 1;
        return Promise.resolve(
          result(
            sliceShow({
              ActiveState: "active",
              ControlGroup: controlGroup,
              ...(shows === 1 ? {} : mutation),
            }),
          ),
        );
      }),
    };
    await expect(
      cleanupSystemdSlice(
        { runner, systemctlExecutable: "/usr/bin/systemctl" },
        record,
      ),
    ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
    expect(runner.run).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["command failure", result("", 1, "failed")],
    ["malformed output", result("LoadState=loaded\n")],
  ])("fails closed on post-stop %s", async (_, postStop) => {
    let shows = 0;
    const runner = {
      run: vi.fn((_executable, args) => {
        if (args[0] !== "show") return Promise.resolve(result(""));
        shows += 1;
        return Promise.resolve(shows === 1 ? result(activeSlice()) : postStop);
      }),
    };
    await expect(
      cleanupSystemdSlice(
        { runner, systemctlExecutable: "/usr/bin/systemctl" },
        record,
      ),
    ).rejects.toThrow("systemd_slice_cleanup_uncertain");
    expect(runner.run).toHaveBeenCalledTimes(4);
  });
});
