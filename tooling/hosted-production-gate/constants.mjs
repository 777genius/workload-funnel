export { ARCHITECTURE_PLAN_SHA256 } from "../production-gate/constants.mjs";

export const HOSTED_GATE_SCHEMA = "workload-funnel.hosted-production-gate.v1";
export const HOSTED_VERDICT_SCHEMA =
  "workload-funnel.hosted-production-gate.verdict.v1";
export const PRODUCTION_GATE_SCHEMA =
  "workload-funnel.production-readiness-gate.v1";
export const PRODUCTION_GATE_RECOVERY_SCHEMA =
  "workload-funnel.production-gate.cleanup-recovery.v1";

export const REQUIRED_PRODUCTION_COMPONENTS = Object.freeze([
  "attestation",
  "preflight",
  "postgres_fixture",
  "postgres_production_adapter",
  "object_compatibility_fixture",
  "object_production_provider",
  "hyperqueue_0_26_2",
  "systemd_cgroup_v2",
  "pressure_admission_slo",
  "cleanup",
]);

export const DISPOSABLE_HOST_ATTESTATION =
  "I_ATTEST_THIS_IS_A_DISPOSABLE_HOST_WITH_NO_USER_PROJECTS";

export const REVIEW_MANIFEST_SCHEMA =
  "workload-funnel.production-gate.review-manifest.v1";

export const HYPERQUEUE = Object.freeze({
  archiveName: "hq-v0.26.2-linux-x64.tar.gz",
  archiveSha256:
    "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5",
  downloadUrl:
    "https://github.com/It4innovations/hyperqueue/releases/download/v0.26.2/hq-v0.26.2-linux-x64.tar.gz",
  version: "0.26.2",
});

export const AWS_CLI = Object.freeze({
  archiveName: "awscli-exe-linux-x86_64-2.35.23.zip",
  archiveSha256:
    "db818de6dd8096d19ac275341721f96bcd70511377446d11c9149a5ed71f8b43",
  archiveUrl:
    "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.35.23.zip",
  signingKeyFingerprint: "FB5DB77FD5C118B80511ADA8A6310ACC4672475C",
  signingKeyUrl:
    "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xA6310ACC4672475C",
  signatureUrl:
    "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.35.23.zip.sig",
  version: "2.35.23",
});

export const PINNED_IMAGES = Object.freeze({
  azuriteFixture:
    "mcr.microsoft.com/azure-storage/azurite:3.35.0@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37",
  objectClient:
    "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
  objectFixture:
    "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2",
  postgresFixture:
    "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15",
});

export const POSTGRES_SIGNING_KEY = Object.freeze({
  fingerprint: "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
  url: "https://www.postgresql.org/media/keys/ACCC4CF8.asc",
});
export const POSTGRES_CLIENT = Object.freeze({
  aptComponent: "main",
  aptRepository: "https://apt.postgresql.org/pub/repos/apt",
  aptSuite: "noble-pgdg",
  packageName: "postgresql-client-18",
  packageVersion: "18.4-1.pgdg24.04+1",
  psqlVersion: "18.4",
});

export const HOST_MINIMUMS = Object.freeze({
  cpuCount: 4,
  diskAvailableBytes: 12 * 1024 * 1024 * 1024,
  diskAvailableRatio: 0.2,
  inodeAvailableRatio: 0.2,
  memoryAvailableBytes: 8 * 1024 * 1024 * 1024,
  memoryAvailableRatio: 0.45,
  memoryTotalBytes: 14 * 1024 * 1024 * 1024,
  pidHeadroom: 4096,
});

export const REQUIRED_CGROUP_CONTROLLERS = Object.freeze([
  "cpu",
  "io",
  "memory",
  "pids",
]);

export const REQUIRED_BOOTSTRAP_TOOLS = Object.freeze([
  "aptGet",
  "chmod",
  "chown",
  "cp",
  "docker",
  "dpkgQuery",
  "findmnt",
  "git",
  "getent",
  "gpg",
  "groupadd",
  "groupdel",
  "id",
  "install",
  "losetup",
  "mount",
  "systemctl",
  "tar",
  "truncate",
  "umount",
  "unzip",
  "useradd",
  "userdel",
]);

export const REVIEWED_EXECUTABLE_NAMES = Object.freeze([
  "aws",
  "docker",
  "hq",
  "id",
  "node",
  "projectQuotaHelper",
  "psql",
  "systemctl",
  "systemdAnalyze",
  "systemdRun",
]);

export const REVIEW_EXCLUDED_NAMES = Object.freeze(
  new Set([
    ".agents",
    ".codex",
    ".git",
    ".pnpm-store",
    ".tmp",
    "coverage",
    "node_modules",
  ]),
);

export const RUNTIME_PACKAGE_NAMES = Object.freeze([
  "@azure/storage-blob",
  "@workload-funnel/artifact-store-object",
  "@workload-funnel/executor-systemd",
  "@workload-funnel/kernel",
  "@workload-funnel/node-execution",
  "@workload-funnel/store-postgres",
]);

// GitHub's ubuntu-24.04 image may omit entries from this baseline, but a
// running service outside it is foreign state and closes admission.
export const HOSTED_RUNNER_SERVICE_BASELINE = Object.freeze([
  "ModemManager.service",
  "accounts-daemon.service",
  "apparmor.service",
  "auditd.service",
  "chrony.service",
  "chronyd.service",
  "cloud-config.service",
  "cloud-final.service",
  "cloud-init-local.service",
  "cloud-init.service",
  "containerd.service",
  "cron.service",
  "dbus.service",
  "docker.service",
  "getty@tty1.service",
  "haveged.service",
  "hosted-compute-agent.service",
  "hv-fcopy-daemon.service",
  "hv-kvp-daemon.service",
  "hv-vss-daemon.service",
  "irqbalance.service",
  "iscsid.service",
  "lvm2-monitor.service",
  "multipathd.service",
  "networkd-dispatcher.service",
  "packagekit.service",
  "php8.3-fpm.service",
  "polkit.service",
  "rsyslog.service",
  "runner-provisioner.service",
  "serial-getty@ttyS0.service",
  "snapd.apparmor.service",
  "snapd.seeded.service",
  "snapd.service",
  "ssh.service",
  "systemd-journald.service",
  "systemd-logind.service",
  "systemd-networkd.service",
  "systemd-oomd.service",
  "systemd-resolved.service",
  "systemd-timesyncd.service",
  "systemd-udevd.service",
  "ua-timer.service",
  "udisks2.service",
  "unattended-upgrades.service",
  "user-runtime-dir@1001.service",
  "user@1001.service",
  "waagent.service",
  "walinuxagent.service",
]);

export const HOSTED_RUNNER_USER_SERVICE_EXECUTABLES = Object.freeze([
  "/usr/bin/dbus-daemon",
  "/usr/lib/systemd/systemd",
  "/usr/lib/systemd/systemd-executor",
  "/usr/libexec/dconf-service",
]);

// Each non-ancestry process on the documented runner image must match one
// exact service/executable tuple. Entries are intentionally absent for
// one-shot units and runner-provisioner: they may be listed as active, but a
// surviving process outside the current Actions process ancestry is foreign.
export const HOSTED_RUNNER_PROCESS_BASELINE = Object.freeze({
  "ModemManager.service": Object.freeze({
    tuples: Object.freeze([
      Object.freeze({
        comm: "ModemManager",
        executable: "/usr/sbin/ModemManager",
        maxProcesses: 1,
        owner: "root",
      }),
    ]),
  }),
  "accounts-daemon.service": Object.freeze({
    executables: Object.freeze(["/usr/libexec/accounts-daemon"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "auditd.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/auditd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "chrony.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/chronyd"]),
    maxProcesses: 2,
    owner: "system",
  }),
  "chronyd.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/chronyd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "containerd.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/containerd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "cron.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/cron"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "dbus.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/dbus-daemon"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "docker.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/dockerd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "getty@tty1.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/agetty"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "haveged.service": Object.freeze({
    tuples: Object.freeze([
      Object.freeze({
        comm: "haveged",
        executable: "/usr/sbin/haveged",
        maxProcesses: 1,
        owner: "root",
      }),
    ]),
  }),
  "hosted-compute-agent.service": Object.freeze({
    tuples: Object.freeze([
      Object.freeze({
        comm: "sudo",
        executable: "/usr/bin/sudo",
        maxProcesses: 1,
        owner: "root",
      }),
      Object.freeze({
        commPattern: /^provjobd[0-9]{1,7}$/u,
        executable: null,
        maxProcesses: 1,
        owner: "root",
      }),
    ]),
  }),
  "hv-fcopy-daemon.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/hv_fcopy_daemon"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "hv-kvp-daemon.service": Object.freeze({
    tuples: Object.freeze([
      Object.freeze({
        comm: "hv_kvp_daemon",
        executablePattern:
          /^\/usr\/lib\/linux-azure-[0-9]+\.[0-9]+-tools-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+\/hv_kvp_daemon$/u,
        maxProcesses: 1,
        owner: "root",
      }),
    ]),
  }),
  "hv-vss-daemon.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/hv_vss_daemon"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "irqbalance.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/irqbalance"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "iscsid.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/iscsid"]),
    maxProcesses: 2,
    owner: "root",
  }),
  "lvm2-monitor.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/dmeventd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "multipathd.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/multipathd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "networkd-dispatcher.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/python3.12"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "packagekit.service": Object.freeze({
    executables: Object.freeze(["/usr/libexec/packagekitd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "php8.3-fpm.service": Object.freeze({
    tuples: Object.freeze([
      Object.freeze({
        comm: "php-fpm8.3",
        executable: "/usr/sbin/php-fpm8.3",
        maxProcesses: 1,
        owner: "root",
      }),
      Object.freeze({
        comm: "php-fpm8.3",
        executable: "/usr/sbin/php-fpm8.3",
        maxProcesses: 2,
        owner: "system",
      }),
    ]),
  }),
  "polkit.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/polkit-1/polkitd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "rsyslog.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/rsyslogd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "serial-getty@ttyS0.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/agetty"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "snapd.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/snapd/snapd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "ssh.service": Object.freeze({
    executables: Object.freeze(["/usr/sbin/sshd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "systemd-journald.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-journald"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "systemd-logind.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-logind"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "systemd-networkd.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-networkd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "systemd-oomd.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-oomd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "systemd-resolved.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-resolved"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "systemd-timesyncd.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-timesyncd"]),
    maxProcesses: 1,
    owner: "system",
  }),
  "systemd-udevd.service": Object.freeze({
    executables: Object.freeze([
      "/usr/bin/udevadm",
      "/usr/lib/systemd/systemd-udevd",
    ]),
    maxProcesses: 1,
    owner: "root",
  }),
  "udisks2.service": Object.freeze({
    executables: Object.freeze(["/usr/libexec/udisks2/udisksd"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "unattended-upgrades.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/python3.12"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "user-runtime-dir@1001.service": Object.freeze({
    executables: Object.freeze(["/usr/lib/systemd/systemd-user-runtime-dir"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "user@1001.service": Object.freeze({
    executables: HOSTED_RUNNER_USER_SERVICE_EXECUTABLES,
    maxProcesses: 8,
    owner: "runner",
  }),
  "waagent.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/python3.12"]),
    maxProcesses: 1,
    owner: "root",
  }),
  "walinuxagent.service": Object.freeze({
    executables: Object.freeze(["/usr/bin/python3.12"]),
    maxProcesses: 2,
    owner: "root",
  }),
});

export const SYNTHETIC_USER = "workload-funnel-synthetic";
export const HOST_ROOT_PREFIX = "/var/lib/workload-funnel-hosted-runtime-";
export const CONTROL_ROOT_PREFIX =
  "/var/lib/workload-funnel-hosted-production-gate-";
export const SANDBOX_PARENT = "/var/data/workload-funnel/sandboxes";
export const ALLOCATION_MOUNT = "/var/lib/workload-funnel";
export const ALLOCATION_PARENT_MODE = 0o711;
export const PROJECT_QUOTA_PARENT_MODE = 0o700;
export const LOOP_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
