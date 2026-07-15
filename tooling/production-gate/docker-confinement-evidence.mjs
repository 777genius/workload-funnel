import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";

function exactPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ipv4Number(value) {
  if (typeof value !== "string") return undefined;
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !/^(?:0|[1-9]\d{0,2})$/u.test(octet) || Number(octet) > 255,
    )
  )
    return undefined;
  return octets.reduce((address, octet) => address * 256 + Number(octet), 0);
}

export function ipv4BelongsToSubnet(address, subnet, prefixLength) {
  const addressNumber = ipv4Number(address);
  const subnetNumber = ipv4Number(subnet);
  if (
    addressNumber === undefined ||
    subnetNumber === undefined ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 1 ||
    prefixLength > 32
  )
    return false;
  const blockSize = 2 ** (32 - prefixLength);
  return (
    Math.floor(addressNumber / blockSize) ===
    Math.floor(subnetNumber / blockSize)
  );
}

export function unpublishedPortMap(value) {
  if (value === null) return true;
  if (!exactPlainObject(value)) return false;
  return Object.values(value).every((bindings) => bindings === null);
}

export function noRequestedPortBindings(value) {
  return (
    value === null ||
    (exactPlainObject(value) && Object.keys(value).length === 0)
  );
}

export function exactSingleIpv4Subnet(network) {
  if (!Array.isArray(network?.IPAM?.Config) || network.IPAM.Config.length !== 1)
    return undefined;
  const config = network.IPAM.Config[0];
  if (!exactPlainObject(config) || typeof config.Subnet !== "string")
    return undefined;
  const match = config.Subnet.match(
    /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})\/(\d{1,2})$/u,
  );
  const prefixLength = Number(match?.[2]);
  if (
    match === null ||
    ipv4Number(match[1]) === undefined ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 1 ||
    prefixLength > 30 ||
    !ipv4BelongsToSubnet(config.Gateway, match[1], prefixLength)
  )
    return undefined;
  return Object.freeze({ address: match[1], prefixLength });
}

function usableIpv4Host(address, subnet) {
  const addressNumber = ipv4Number(address);
  const subnetNumber = ipv4Number(subnet?.address);
  if (addressNumber === undefined || subnetNumber === undefined) return false;
  const blockSize = 2 ** (32 - subnet.prefixLength);
  const networkAddress = Math.floor(subnetNumber / blockSize) * blockSize;
  return (
    addressNumber > networkAddress &&
    addressNumber < networkAddress + blockSize - 1
  );
}

export function exactOwnedNetworkMembers(network, runId, subnet) {
  if (!exactPlainObject(network?.Containers)) return false;
  const addresses = [];
  const endpointIdentities = [];
  const macAddresses = [];
  for (const [identity, member] of Object.entries(network.Containers)) {
    if (
      !/^[a-f0-9]{12,64}$/u.test(identity) ||
      !exactPlainObject(member) ||
      !OWNED_RESOURCE_PATTERN.test(member.Name ?? "") ||
      !member.Name.startsWith(`${runId}-`) ||
      !/^[a-f0-9]{12,64}$/u.test(member.EndpointID ?? "") ||
      !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(member.MacAddress ?? "") ||
      member.IPv6Address !== "" ||
      typeof member.IPv4Address !== "string"
    )
      return false;
    const match = member.IPv4Address.match(
      /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})\/(\d{1,2})$/u,
    );
    if (
      match === null ||
      Number(match[2]) !== subnet.prefixLength ||
      !usableIpv4Host(match[1], subnet) ||
      !ipv4BelongsToSubnet(match[1], subnet.address, subnet.prefixLength)
    )
      return false;
    addresses.push(match[1]);
    endpointIdentities.push(member.EndpointID);
    macAddresses.push(member.MacAddress);
  }
  return (
    new Set(addresses).size === addresses.length &&
    new Set(endpointIdentities).size === endpointIdentities.length &&
    new Set(macAddresses).size === macAddresses.length
  );
}

export function exactBindMounts(
  mounts,
  expectedWritableStorage,
  expectedSecrets,
) {
  if (!Array.isArray(mounts) || !Array.isArray(expectedSecrets)) return false;
  const expected = [
    ...(expectedWritableStorage?.kind === "bind"
      ? [
          {
            destination: expectedWritableStorage.destination,
            readWrite: true,
            source: expectedWritableStorage.source,
          },
        ]
      : []),
    ...expectedSecrets.map(({ destination, source }) => ({
      destination,
      readWrite: false,
      source,
    })),
  ];
  return exactMounts(mounts, expected);
}

function exactMounts(mounts, expected) {
  return (
    Array.isArray(mounts) &&
    Array.isArray(expected) &&
    mounts.length === expected.length &&
    expected.every(({ destination, readWrite, source }) =>
      mounts.some(
        (mount) =>
          exactPlainObject(mount) &&
          mount.Type === "bind" &&
          mount.Source === source &&
          mount.Destination === destination &&
          mount.RW === readWrite &&
          mount.Propagation === "rprivate",
      ),
    )
  );
}

export function exactReadOnlyBindMounts(mounts, expectedMounts) {
  if (!Array.isArray(expectedMounts)) return false;
  return exactMounts(
    mounts,
    expectedMounts.map(({ destination, source }) => ({
      destination,
      readWrite: false,
      source,
    })),
  );
}

function transientEmptyEndpoint(endpoint, networkIdentity) {
  return (
    exactPlainObject(endpoint) &&
    new Set(["", networkIdentity]).has(endpoint.NetworkID) &&
    endpoint.EndpointID === "" &&
    endpoint.IPAddress === "" &&
    endpoint.IPPrefixLen === 0 &&
    endpoint.MacAddress === ""
  );
}

export function evaluateInternalEndpoint({
  attachedNetworks,
  containerIdentity,
  name,
  network,
  networkName,
  runId,
  subnet,
}) {
  if (
    subnet === undefined ||
    !exactPlainObject(attachedNetworks) ||
    !exactOwnedNetworkMembers(network, runId, subnet)
  )
    return Object.freeze({ state: "invalid" });
  const networkNames = Object.keys(attachedNetworks);
  if (
    networkNames.length > 1 ||
    (networkNames.length === 1 && networkNames[0] !== networkName)
  )
    return Object.freeze({ state: "invalid" });
  const observedEndpoint = attachedNetworks[networkName];
  const endpointAbsent =
    networkNames.length === 0 ||
    transientEmptyEndpoint(observedEndpoint, network.Id);
  const endpoint = endpointAbsent ? undefined : observedEndpoint;
  if (
    endpoint !== undefined &&
    (!exactPlainObject(endpoint) ||
      !/^[a-f0-9]{12,64}$/u.test(endpoint.NetworkID ?? "") ||
      endpoint.NetworkID !== network.Id ||
      !/^[a-f0-9]{12,64}$/u.test(endpoint.EndpointID ?? "") ||
      !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(endpoint.MacAddress ?? "") ||
      ipv4Number(endpoint.IPAddress) === undefined ||
      !Number.isSafeInteger(endpoint.IPPrefixLen) ||
      endpoint.IPPrefixLen !== subnet.prefixLength ||
      !usableIpv4Host(endpoint.IPAddress, subnet) ||
      !ipv4BelongsToSubnet(
        endpoint.IPAddress,
        subnet.address,
        subnet.prefixLength,
      ))
  )
    return Object.freeze({ state: "invalid" });
  const membership = network.Containers[containerIdentity];
  const staleMembership = Object.entries(network.Containers).some(
    ([identity, member]) =>
      identity !== containerIdentity &&
      (member.Name === name ||
        (endpoint !== undefined &&
          (member.EndpointID === endpoint.EndpointID ||
            member.MacAddress === endpoint.MacAddress ||
            member.IPv4Address ===
              `${endpoint.IPAddress}/${String(endpoint.IPPrefixLen)}`))),
  );
  if (staleMembership) return Object.freeze({ state: "invalid" });
  if (membership !== undefined && membership.Name !== name)
    return Object.freeze({ state: "invalid" });
  if (endpoint === undefined || membership === undefined)
    return Object.freeze({ state: "transient-absence" });
  if (
    membership.Name !== name ||
    membership.EndpointID !== endpoint.EndpointID ||
    membership.MacAddress !== endpoint.MacAddress ||
    membership.IPv4Address !==
      `${endpoint.IPAddress}/${String(endpoint.IPPrefixLen)}` ||
    membership.IPv6Address !== ""
  )
    return Object.freeze({ state: "invalid" });
  return Object.freeze({
    ipv4Address: endpoint.IPAddress,
    state: "exact",
  });
}
