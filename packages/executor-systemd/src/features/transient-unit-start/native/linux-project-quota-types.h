#ifndef WF_LINUX_PROJECT_QUOTA_TYPES_H
#define WF_LINUX_PROJECT_QUOTA_TYPES_H

#include <stdint.h>

#define RECEIPT_SCHEMA "workload-funnel.linux-project-quota-receipt.v2"
#define NO_PRIOR_CHECKSUM "0000000000000000000000000000000000000000000000000000000000000000"
#define CAPABILITY_SCHEMA "workload-funnel.linux-project-quota-capability.v1"
#define VERIFICATION "exact-linux-project-quota-root-mount-identity-and-limits"
#define PRODUCTION_ALLOCATION_ROOT "/var/lib/workload-funnel/allocations"
#define PRODUCTION_RECEIPT_ROOT "/var/lib/workload-funnel/project-quota"
#define MAX_RECEIPT_SIZE 16384

typedef struct {
  char allocation_id[129];
  uint32_t project_id;
  char root[512];
  uint64_t maximum_bytes;
  uint64_t inode_maximum;
  char control_digest[65];
  char fence_fingerprint[74];
  char execution_generation[257];
  uint64_t cluster_version;
  uint64_t writer_epoch;
  uint64_t gate_revision;
  uint64_t owner_fence;
  uint64_t desired_version;
  uint64_t start_revocation;
} Request;

typedef struct {
  uint64_t mount_id;
  unsigned int device_major;
  unsigned int device_minor;
  char filesystem[8];
  char mount_option[16];
  char boot_id[37];
} MountIdentity;

typedef struct {
  uint64_t hard_bytes;
  uint64_t hard_inodes;
  uint64_t used_bytes;
  uint64_t used_inodes;
} QuotaState;

typedef struct {
  char status[32];
  Request request;
  uint64_t root_major;
  uint64_t root_minor;
  uint64_t root_inode;
  MountIdentity mount;
  uint32_t applied_project_id;
  uint64_t effective_bytes;
  uint64_t effective_inodes;
  uint64_t revision;
  char prior_checksum[65];
  char checksum[65];
} Receipt;

#endif
