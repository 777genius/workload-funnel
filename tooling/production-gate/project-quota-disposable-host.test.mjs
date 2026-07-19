import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled =
  process.env.WF_PROJECT_QUOTA_DISPOSABLE_TEST === "1" &&
  process.getuid?.() === 0;
const describeDisposable = enabled ? describe : describe.skip;
const source = resolve(
  "packages/executor-systemd/src/features/transient-unit-start/native/linux-project-quota.c",
);
const roots = [];
let fixture;

function executable(...paths) {
  const path = paths.find((candidate) => existsSync(candidate));
  if (path === undefined)
    throw new Error("disposable_quota_fixture_tool_missing");
  return path;
}

function run(path, arguments_, extraEnv = {}) {
  return spawnSync(path, arguments_, {
    encoding: "utf8",
    env: {
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TZ: "UTC",
      ...extraEnv,
    },
    maxBuffer: 64 * 1024,
  });
}

function controlDigest(allocationId, projectId, root, bytes, inodes) {
  return createHash("sha256")
    .update(
      [
        allocationId,
        String(projectId),
        root,
        String(bytes),
        String(inodes),
      ].join("\0"),
    )
    .digest("hex");
}

function request(allocationId, projectId, bytes, inodes) {
  const root = join(fixture.allocations, allocationId);
  return [
    fixture.allocations,
    fixture.receipts,
    allocationId,
    String(projectId),
    String(bytes),
    String(inodes),
    controlDigest(allocationId, projectId, root, bytes, inodes),
    `fence-v1-${"a".repeat(64)}`,
    `generation-${allocationId}`,
    "1",
    "1",
    "1",
    "1",
    "1",
    "0",
  ];
}

function receiptDigest(stdout) {
  const fields = stdout.trimEnd().split("\t");
  if (fields.length !== 32) throw new Error("disposable_receipt_malformed");
  return fields[31];
}

function apply(arguments_) {
  const applied = run(fixture.helper, ["apply", ...arguments_]);
  if (applied.status !== 0)
    throw new Error(applied.stderr.trim() || "disposable_quota_apply_failed");
  return applied;
}

function remove(arguments_, digest) {
  const removed = run(fixture.helper, ["remove", ...arguments_, digest]);
  if (removed.status !== 0)
    throw new Error(removed.stderr.trim() || "disposable_quota_remove_failed");
  return removed;
}

function cleanup(arguments_) {
  const cleaned = run(fixture.helper, ["cleanup", ...arguments_]);
  if (cleaned.status !== 0)
    throw new Error(cleaned.stderr.trim() || "disposable_quota_cleanup_failed");
  return cleaned;
}

describeDisposable(
  "disposable Linux project quota adversarial contract",
  () => {
    beforeAll(() => {
      const root = mkdtempSync(join(tmpdir(), "wf-project-quota-disposable-"));
      roots.push(root);
      const image = join(root, "quota.img");
      const imageDescriptor = openSync(
        image,
        constants.O_CREAT | constants.O_RDWR | constants.O_EXCL,
        0o600,
      );
      try {
        const imageBytes = 512 * 1024 * 1024;
        writeFileSync(imageDescriptor, Buffer.alloc(1), {
          flag: "r+",
        });
        execFileSync("/usr/bin/truncate", [
          "--size",
          String(imageBytes),
          image,
        ]);
      } finally {
        closeSync(imageDescriptor);
      }
      const mount = join(root, "mount");
      mkdirSync(mount, { mode: 0o700 });
      const mkfsXfs = ["/usr/sbin/mkfs.xfs", "/usr/bin/mkfs.xfs"].find(
        existsSync,
      );
      if (mkfsXfs !== undefined) {
        execFileSync(mkfsXfs, ["-f", image]);
      } else {
        execFileSync(executable("/usr/sbin/mkfs.ext4", "/usr/bin/mkfs.ext4"), [
          "-F",
          "-O",
          "quota,project",
          image,
        ]);
      }
      const loopDevice = execFileSync("/usr/sbin/losetup", [
        "--find",
        "--show",
        image,
      ])
        .toString()
        .trim();
      execFileSync("/usr/bin/mount", ["-o", "prjquota", loopDevice, mount]);
      const allocations = join(mount, "allocations");
      const receipts = join(mount, "receipts");
      mkdirSync(allocations, { mode: 0o700 });
      mkdirSync(receipts, { mode: 0o700 });
      const helper = join(root, "linux-project-quota-test");
      execFileSync("/usr/bin/cc", [
        "-std=c17",
        "-DWF_PROJECT_QUOTA_TEST_ROOTS",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        source,
        "-o",
        helper,
      ]);
      chmodSync(helper, 0o700);
      fixture = {
        allocations,
        helper,
        image,
        loopDevice,
        mount,
        receipts,
        root,
      };
      const probe = run(helper, ["probe", allocations, receipts]);
      if (probe.status !== 0)
        throw new Error(probe.stderr.trim() || "disposable_quota_probe_failed");
    });

    afterAll(() => {
      if (fixture?.mount !== undefined)
        spawnSync("/usr/bin/umount", [fixture.mount], { encoding: "utf8" });
      if (fixture?.loopDevice !== undefined)
        spawnSync("/usr/sbin/losetup", ["--detach", fixture.loopDevice]);
      for (const root of roots.splice(0))
        rmSync(root, { force: true, recursive: true });
    });

    it("persists and reopens the exact verified receipt before a launch marker", () => {
      mkdirSync(join(fixture.allocations, "allocation-reopen"), {
        mode: 0o700,
      });
      const arguments_ = request("allocation-reopen", 1_500_001, 4_194_304, 64);
      const first = apply(arguments_);
      expect(first.stdout.split("\t", 2)[1]).toBe("applied");
      const second = apply(arguments_);
      expect(second.stdout.split("\t", 2)[1]).toBe("verified_existing");
      const marker = join(fixture.root, "launch-authorized");
      writeFileSync(marker, receiptDigest(second.stdout), {
        flag: "wx",
        mode: 0o600,
      });
      expect(existsSync(marker)).toBe(true);
      const sentinel = run(fixture.helper, [
        "remove",
        ...arguments_,
        "0".repeat(64),
      ]);
      expect(sentinel.status).toBe(2);
      expect(sentinel.stderr).toContain(
        "project_quota_expected_receipt_mismatch",
      );
      remove(arguments_, receiptDigest(second.stdout));
    });

    it("rejects stale generation and owner-fence receipts after reopen", () => {
      mkdirSync(join(fixture.allocations, "allocation-fence"), { mode: 0o700 });
      const current = request("allocation-fence", 1_500_005, 4_194_304, 64);
      const applied = apply(current);
      const staleGeneration = [...current];
      staleGeneration[8] = "generation-stale";
      expect(
        run(fixture.helper, ["apply", ...staleGeneration]).stderr,
      ).toContain("project_quota_receipt_tuple_mismatch");
      const staleFence = [...current];
      staleFence[7] = `fence-v1-${"c".repeat(64)}`;
      staleFence[12] = "0";
      expect(run(fixture.helper, ["apply", ...staleFence]).stderr).toContain(
        "project_quota_stale_mutation_fence",
      );
      remove(current, receiptDigest(applied.stdout));
    });

    it("rejects project-ID collisions and renamed or symlinked workspace roots", () => {
      const outside = join(fixture.root, "outside");
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(fixture.allocations, "allocation-symlink"));
      const symlinked = run(fixture.helper, [
        "apply",
        ...request("allocation-symlink", 1_500_004, 4_194_304, 64),
      ]);
      expect(symlinked.status).toBe(2);
      expect(symlinked.stderr).toContain(
        "project_quota_workspace_open_refused",
      );

      mkdirSync(join(fixture.allocations, "allocation-owner"), { mode: 0o700 });
      mkdirSync(join(fixture.allocations, "allocation-collision"), {
        mode: 0o700,
      });
      const owner = request("allocation-owner", 1_500_002, 4_194_304, 64);
      const ownerReceipt = apply(owner);
      const collision = run(fixture.helper, [
        "apply",
        ...request("allocation-collision", 1_500_002, 4_194_304, 64),
      ]);
      expect(collision.status).toBe(2);
      expect(collision.stderr).toContain("project_quota_project_id_collision");

      const original = join(fixture.allocations, "allocation-owner");
      const renamed = join(fixture.allocations, "allocation-owner-renamed");
      renameSync(original, renamed);
      mkdirSync(original, { mode: 0o700 });
      const stale = run(fixture.helper, [
        "verify",
        ...owner,
        receiptDigest(ownerReceipt.stdout),
      ]);
      expect(stale.status).toBe(2);
      expect(stale.stderr).toContain("project_quota_receipt_tuple_mismatch");
      rmSync(original, { recursive: true });
      renameSync(renamed, original);
      remove(owner, receiptDigest(ownerReceipt.stdout));
    });

    it("enforces byte and inode hard limits on a newly mounted fixture only", () => {
      mkdirSync(join(fixture.allocations, "allocation-limits"), {
        mode: 0o700,
      });
      const arguments_ = request("allocation-limits", 1_500_003, 1_048_576, 16);
      const applied = apply(arguments_);
      expect(() =>
        writeFileSync(
          join(fixture.allocations, "allocation-limits", "too-large"),
          Buffer.alloc(2 * 1024 * 1024),
        ),
      ).toThrow();
      let refused = false;
      for (let index = 0; index < 32; index++) {
        try {
          writeFileSync(
            join(fixture.allocations, "allocation-limits", `inode-${index}`),
            "",
            { flag: "wx" },
          );
        } catch {
          refused = true;
          break;
        }
      }
      expect(refused).toBe(true);
      remove(arguments_, receiptDigest(applied.stdout));
    });

    it.each([
      "after_prepared_removal",
      "after_project_identity_cleared",
      "after_quota_cleared",
      "after_removed_receipt",
    ])("recovers idempotently from removal crash point %s", (crashPoint) => {
      const suffix = crashPoint.replaceAll("_", "-");
      const allocationId = `allocation-crash-${suffix}`;
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const arguments_ = request(
        allocationId,
        1_510_000 +
          [
            "after_prepared_removal",
            "after_project_identity_cleared",
            "after_quota_cleared",
            "after_removed_receipt",
          ].indexOf(crashPoint),
        4_194_304,
        64,
      );
      const applied = apply(arguments_);
      const digest = receiptDigest(applied.stdout);
      const crashed = run(fixture.helper, ["remove", ...arguments_, digest], {
        WF_PROJECT_QUOTA_TEST_CRASH_POINT: crashPoint,
      });
      expect(crashed.status).toBe(86);

      const recovered = remove(arguments_, digest);
      expect(recovered.stdout.split("\t", 2)[1]).toBe("removed");
      const replayed = remove(arguments_, digest);
      expect(replayed.stdout).toBe(recovered.stdout);
    });

    it.each([
      "after_prepared_application_receipt",
      "after_project_identity_applied",
      "after_quota_applied",
    ])("rolls back an interrupted application from %s", (crashPoint) => {
      const suffix = crashPoint.replaceAll("_", "-");
      const allocationId = `allocation-apply-crash-${suffix}`;
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const arguments_ = request(
        allocationId,
        1_515_000 +
          [
            "after_prepared_application_receipt",
            "after_project_identity_applied",
            "after_quota_applied",
          ].indexOf(crashPoint),
        4_194_304,
        64,
      );
      const crashed = run(fixture.helper, ["apply", ...arguments_], {
        WF_PROJECT_QUOTA_TEST_CRASH_POINT: crashPoint,
      });
      expect(crashed.status).toBe(86);

      const recovered = cleanup(arguments_);
      expect(recovered.stdout.split("\t", 2)[1]).toBe("removed");
      expect(cleanup(arguments_).stdout).toBe(recovered.stdout);
    });

    it.each(["after_prepared_removal", "after_removed_receipt"])(
      "recovers expected-only cleanup after a second crash at %s",
      (crashPoint) => {
        const suffix = crashPoint.replaceAll("_", "-");
        const allocationId = `allocation-cleanup-crash-${suffix}`;
        mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
        const arguments_ = request(
          allocationId,
          1_516_000 +
            ["after_prepared_removal", "after_removed_receipt"].indexOf(
              crashPoint,
            ),
          4_194_304,
          64,
        );
        apply(arguments_);
        const crashed = run(fixture.helper, ["cleanup", ...arguments_], {
          WF_PROJECT_QUOTA_TEST_CRASH_POINT: crashPoint,
        });
        expect(crashed.status).toBe(86);

        const recovered = cleanup(arguments_);
        expect(recovered.stdout.split("\t", 2)[1]).toBe("removed");
        expect(cleanup(arguments_).stdout).toBe(recovered.stdout);
      },
    );

    it("treats an exact empty allocation without a receipt as absent", () => {
      const allocationId = "allocation-cleanup-absent";
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const arguments_ = request(allocationId, 1_517_001, 4_194_304, 64);
      expect(cleanup(arguments_).stdout).toBe("result\tabsent\n");
    });

    it("never clears another allocation through receipt-free cleanup", () => {
      const ownerId = "allocation-cleanup-owner";
      const foreignId = "allocation-cleanup-foreign";
      const projectId = 1_517_002;
      mkdirSync(join(fixture.allocations, ownerId), { mode: 0o700 });
      mkdirSync(join(fixture.allocations, foreignId), { mode: 0o700 });
      const owner = request(ownerId, projectId, 4_194_304, 64);
      const ownerReceipt = apply(owner);
      const foreign = request(foreignId, projectId, 4_194_304, 64);

      const refused = run(fixture.helper, ["cleanup", ...foreign]);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain(
        "project_quota_unregistered_cleanup_refused",
      );
      const verifiedOwner = run(fixture.helper, [
        "verify",
        ...owner,
        receiptDigest(ownerReceipt.stdout),
      ]);
      expect(verifiedOwner.status).toBe(0);
      remove(owner, receiptDigest(ownerReceipt.stdout));
    });

    it("rebinds an already removed receipt to a newer cleanup fence", () => {
      const allocationId = "allocation-cleanup-newer-fence";
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const original = request(allocationId, 1_518_001, 4_194_304, 64);
      apply(original);
      cleanup(original);
      const newer = [...original];
      newer[7] = `fence-v1-${"e".repeat(64)}`;
      newer[12] = "2";

      const rebound = cleanup(newer);
      const fields = rebound.stdout.trimEnd().split("\t");
      expect(fields[10]).toBe(newer[7]);
      expect(fields[15]).toBe("2");
      expect(cleanup(newer).stdout).toBe(rebound.stdout);
    });

    it("persists the full newer removal fence and replays it exactly", () => {
      const allocationId = "allocation-newer-removal";
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const original = request(allocationId, 1_520_001, 4_194_304, 64);
      const applied = apply(original);
      const activeDigest = receiptDigest(applied.stdout);
      const newer = [...original];
      newer[7] = `fence-v1-${"d".repeat(64)}`;
      newer[12] = "2";

      const removed = remove(newer, activeDigest);
      const fields = removed.stdout.trimEnd().split("\t");
      expect(fields[10]).toBe(newer[7]);
      expect(fields[15]).toBe("2");
      expect(remove(newer, activeDigest).stdout).toBe(removed.stdout);
    });

    it("rejects a descendant mount that could escape project quota", () => {
      const allocationId = "allocation-descendant-mount";
      const allocation = join(fixture.allocations, allocationId);
      const nested = join(allocation, "nested");
      mkdirSync(nested, { mode: 0o700, recursive: true });
      execFileSync("/usr/bin/mount", [
        "-t",
        "tmpfs",
        "-o",
        "size=8m,mode=0700",
        "none",
        nested,
      ]);
      try {
        const applied = run(fixture.helper, [
          "apply",
          ...request(allocationId, 1_520_002, 4_194_304, 64),
        ]);
        expect(applied.status).toBe(2);
        expect(applied.stderr).toContain(
          "project_quota_descendant_mount_present",
        );
      } finally {
        execFileSync("/usr/bin/umount", [nested]);
      }
    });

    it("requires receipts on the exact allocation filesystem", () => {
      const outsideReceipts = join(fixture.root, "outside-receipts");
      mkdirSync(outsideReceipts, { mode: 0o700 });
      execFileSync("/usr/bin/mount", [
        "--bind",
        fixture.receipts,
        outsideReceipts,
      ]);
      try {
        const probe = run(fixture.helper, [
          "probe",
          fixture.allocations,
          outsideReceipts,
        ]);
        expect(probe.status).toBe(2);
        expect(probe.stderr).toContain(
          "project_quota_receipt_root_mount_mismatch",
        );
      } finally {
        execFileSync("/usr/bin/umount", [outsideReceipts]);
      }
    });

    it("removes an active allocation after the same device is remounted", () => {
      const allocationId = "allocation-remount-cleanup";
      mkdirSync(join(fixture.allocations, allocationId), { mode: 0o700 });
      const arguments_ = request(allocationId, 1_520_003, 4_194_304, 64);
      const applied = apply(arguments_);
      const activeDigest = receiptDigest(applied.stdout);

      execFileSync("/usr/bin/umount", [fixture.mount]);
      execFileSync("/usr/bin/mount", [
        "-o",
        "prjquota",
        fixture.loopDevice,
        fixture.mount,
      ]);

      const removed = remove(arguments_, activeDigest);
      expect(removed.stdout.split("\t", 2)[1]).toBe("removed");
      expect(remove(arguments_, activeDigest).stdout).toBe(removed.stdout);
    });

    it("reports unsupported filesystems from a disposable tmpfs mount", () => {
      const unsupported = join(fixture.root, "unsupported");
      const unsupportedReceipts = join(fixture.root, "unsupported-receipts");
      mkdirSync(unsupported, { mode: 0o700 });
      mkdirSync(unsupportedReceipts, { mode: 0o700 });
      execFileSync("/usr/bin/mount", [
        "-t",
        "tmpfs",
        "-o",
        "size=8m,mode=0700",
        "none",
        unsupported,
      ]);
      try {
        const probe = run(fixture.helper, [
          "probe",
          unsupported,
          unsupportedReceipts,
        ]);
        expect(probe.status).toBe(2);
        expect(probe.stderr).toContain("project_quota_filesystem_unsupported");
      } finally {
        execFileSync("/usr/bin/umount", [unsupported]);
      }
    });
  },
);
