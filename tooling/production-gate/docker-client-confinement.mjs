import {
  exactReadOnlyBindMounts,
  noRequestedPortBindings,
  unpublishedPortMap,
} from "./docker-confinement-evidence.mjs";

export const CLIENT_TMPFS_OPTIONS = Object.freeze({
  "/gate/mc": "rw,nosuid,nodev,noexec,size=4194304,uid=1000,gid=1000,mode=0700",
  "/tmp": "rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700",
});

function exactStringMap(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, expectedValue]) => value[key] === expectedValue,
    )
  );
}

export function exactClientConfinement({
  expectedImage,
  expectedMounts,
  identity,
  inspected,
  name,
  networkName,
  publishedPorts,
}) {
  const host = inspected?.HostConfig;
  const container = inspected?.Config;
  return (
    inspected?.Id === identity &&
    (expectedImage === undefined || container?.Image === expectedImage) &&
    container?.Labels?.["workload-funnel.production-gate.resource"] === name &&
    container?.User === "1000:1000" &&
    host?.Privileged === false &&
    host?.ReadonlyRootfs === true &&
    host?.Init === true &&
    host?.IpcMode === "private" &&
    host?.UTSMode === "" &&
    host?.NetworkMode === networkName &&
    host?.Memory === 268_435_456 &&
    host?.MemorySwap === 268_435_456 &&
    host?.NanoCpus === 1_000_000_000 &&
    host?.PidsLimit === 64 &&
    host?.RestartPolicy?.Name === "no" &&
    Array.isArray(host?.CapDrop) &&
    host.CapDrop.length === 1 &&
    host.CapDrop[0] === "ALL" &&
    (host.CapAdd === null ||
      (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) &&
    Array.isArray(host?.SecurityOpt) &&
    host.SecurityOpt.length === 1 &&
    host.SecurityOpt[0] === "no-new-privileges=true" &&
    exactStringMap(host?.Tmpfs, CLIENT_TMPFS_OPTIONS) &&
    exactReadOnlyBindMounts(inspected?.Mounts, expectedMounts) &&
    noRequestedPortBindings(host?.PortBindings) &&
    unpublishedPortMap(inspected?.NetworkSettings?.Ports) &&
    publishedPorts.code === 0 &&
    publishedPorts.stdout === "" &&
    publishedPorts.stderr === ""
  );
}
