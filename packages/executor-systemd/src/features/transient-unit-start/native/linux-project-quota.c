#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/dqblk_xfs.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/quota.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <unistd.h>
#include "linux-project-quota-types.h"
#include "wf-sha256.h"

static void die(const char *reason) {
  fprintf(stderr, "%s\n", reason);
  exit(2);
}
static int safe_identifier(const char *value, size_t maximum) {
  size_t length = strlen(value);
  if (length < 1 || length > maximum)
    return 0;
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)value[index];
    if (!((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
          (byte >= '0' && byte <= '9') || strchr("._:/-", byte)))
      return 0;
  }
  return value[0] != '/' && !strstr(value, "..") && !strchr(value, '\t') &&
         !strchr(value, '\n');
}
static int safe_allocation_id(const char *value) {
  size_t length = strlen(value);
  if (length < 1 || length > 128)
    return 0;
  for (size_t index = 0; index < length; index++)
    if (!((value[index] >= 'a' && value[index] <= 'z') ||
          (value[index] >= '0' && value[index] <= '9') || value[index] == '-'))
      return 0;
  return 1;
}
static uint64_t unsigned_number(const char *value) {
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0'))
    die("invalid_project_quota_number");
  for (size_t index = 0; value[index] != '\0'; index++)
    if (value[index] < '0' || value[index] > '9')
      die("invalid_project_quota_number");
  char *end = NULL;
  errno = 0;
  unsigned long long number = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0')
    die("invalid_project_quota_number");
  return (uint64_t)number;
}
static void exact_digest(const char *value, const char *reason) {
  if (strlen(value) != 64)
    die(reason);
  for (size_t index = 0; index < 64; index++)
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      die(reason);
}
static int open_resolved(int parent, const char *path, int flags,
                         uint64_t resolve) {
  struct open_how how = {
      .flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW),
      .resolve = resolve};
  return (int)syscall(SYS_openat2, parent, path, &how, sizeof(how));
}
static int open_trusted_root(const char *path, const char *expected) {
#ifndef WF_PROJECT_QUOTA_TEST_ROOTS
  if (strcmp(path, expected) != 0)
    die("project_quota_root_not_allowlisted");
#else
  (void)expected;
#endif
  struct stat metadata;
  int descriptor = open_resolved(
      AT_FDCWD, path, O_RDONLY | O_DIRECTORY,
      RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS);
  if (descriptor < 0 || fstat(descriptor, &metadata) != 0 ||
      !S_ISDIR(metadata.st_mode) || metadata.st_uid != 0 ||
      metadata.st_gid != 0 || (metadata.st_mode & 0022) != 0)
    die("project_quota_root_untrusted");
  return descriptor;
}
static void read_boot_id(char output[37]) {
  int descriptor = open("/proc/sys/kernel/random/boot_id",
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  char buffer[40] = {0};
  ssize_t length = descriptor < 0 ? -1 : read(descriptor, buffer, 37);
  if (descriptor >= 0)
    close(descriptor);
  if (length != 37 || buffer[36] != '\n')
    die("project_quota_boot_identity_unavailable");
  buffer[36] = '\0';
  if (strlen(buffer) != 36)
    die("project_quota_boot_identity_unavailable");
  memcpy(output, buffer, 37);
}
static int option_present(const char *options, const char *name) {
  size_t length = strlen(name);
  const char *cursor = options;
  while ((cursor = strstr(cursor, name)) != NULL) {
    if ((cursor == options || cursor[-1] == ',') &&
        (cursor[length] == '\0' || cursor[length] == ','))
      return 1;
    cursor += length;
  }
  return 0;
}
static MountIdentity mount_identity(int descriptor) {
  struct stat metadata;
  struct statfs filesystem;
  struct statx extended = {0};
  if (fstat(descriptor, &metadata) != 0 || fstatfs(descriptor, &filesystem) != 0)
    die("project_quota_mount_identity_unavailable");
  if (statx(descriptor, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
            STATX_MNT_ID, &extended) != 0 ||
      (extended.stx_mask & STATX_MNT_ID) == 0)
    die("project_quota_mount_id_unavailable");
  MountIdentity identity = {
      .mount_id = extended.stx_mnt_id,
      .device_major = major(metadata.st_dev),
      .device_minor = minor(metadata.st_dev)};
  if (filesystem.f_type == XFS_SUPER_MAGIC)
    strcpy(identity.filesystem, "xfs");
  else if (filesystem.f_type == EXT4_SUPER_MAGIC)
    strcpy(identity.filesystem, "ext4");
  else
    die("project_quota_filesystem_unsupported");

  FILE *mounts = fopen("/proc/self/mountinfo", "re");
  if (mounts == NULL)
    die("project_quota_mountinfo_unavailable");
  char *line = NULL;
  size_t capacity = 0;
  int matches = 0;
  while (getline(&line, &capacity, mounts) >= 0) {
    char *copy = strdup(line), *save = NULL, *tokens[128];
    size_t count = 0;
    if (copy == NULL)
      die("project_quota_out_of_memory");
    for (char *token = strtok_r(copy, " \n", &save);
         token != NULL && count < 128;
         token = strtok_r(NULL, " \n", &save))
      tokens[count++] = token;
    if (count >= 10 && unsigned_number(tokens[0]) == identity.mount_id) {
      size_t separator = 6;
      while (separator < count && strcmp(tokens[separator], "-") != 0)
        separator++;
      unsigned int observed_major = 0, observed_minor = 0;
      if (separator + 3 >= count ||
          sscanf(tokens[2], "%u:%u", &observed_major, &observed_minor) != 2 ||
          observed_major != identity.device_major ||
          observed_minor != identity.device_minor ||
          strcmp(tokens[separator + 1], identity.filesystem) != 0)
        die("project_quota_mount_identity_mismatch");
      const char *mount_options = tokens[5];
      const char *super_options = tokens[separator + 3];
      if (option_present(mount_options, "prjquota") ||
          option_present(super_options, "prjquota"))
        strcpy(identity.mount_option, "prjquota");
      else if (strcmp(identity.filesystem, "xfs") == 0 &&
               (option_present(mount_options, "pquota") ||
                option_present(super_options, "pquota")))
        strcpy(identity.mount_option, "pquota");
      else
        die("project_quota_mount_option_missing");
      matches++;
    }
    free(copy);
  }
  free(line);
  if (ferror(mounts) != 0 || fclose(mounts) != 0)
    die("project_quota_mountinfo_unavailable");
  if (matches != 1)
    die("project_quota_mount_identity_ambiguous");
  read_boot_id(identity.boot_id);
  return identity;
}
static int quota_call(int descriptor, int command, int identifier, void *data) {
#ifdef SYS_quotactl_fd
  return (int)syscall(SYS_quotactl_fd, descriptor, command, identifier, data);
#else
  (void)descriptor;
  (void)command;
  (void)identifier;
  (void)data;
  errno = ENOSYS;
  return -1;
#endif
}

static void verify_quota_active(int descriptor, const MountIdentity *mount) {
  if (strcmp(mount->filesystem, "xfs") == 0) {
    struct fs_quota_statv status = {.qs_version = FS_QSTATV_VERSION1};
    if (quota_call(descriptor, QCMD(Q_XGETQSTATV, PRJQUOTA), 0, &status) != 0 ||
        (status.qs_flags & (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD)) !=
            (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD))
      die("project_quota_kernel_capability_missing");
  } else {
    struct if_dqinfo information = {0};
    if (quota_call(descriptor, QCMD(Q_GETINFO, PRJQUOTA), 0, &information) != 0)
      die(errno == ENOSYS ? "project_quota_quotactl_fd_unavailable"
                          : "project_quota_kernel_capability_missing");
  }
}

static QuotaState read_quota(int descriptor, const MountIdentity *mount,
                             uint32_t project_id) {
  QuotaState state = {0};
  if (strcmp(mount->filesystem, "xfs") == 0) {
    struct fs_disk_quota quota = {.d_version = FS_DQUOT_VERSION,
                                  .d_flags = FS_PROJ_QUOTA,
                                  .d_id = project_id};
    if (quota_call(descriptor, QCMD(Q_XGETQUOTA, PRJQUOTA),
                   (int)project_id, &quota) != 0) {
      if (errno == ENOENT)
        return state;
      die(errno == ENOSYS ? "project_quota_quotactl_fd_unavailable"
                          : "project_quota_kernel_capability_missing");
    }
    state.hard_bytes = quota.d_blk_hardlimit * 512ULL;
    state.hard_inodes = quota.d_ino_hardlimit;
    state.used_bytes = quota.d_bcount * 512ULL;
    state.used_inodes = quota.d_icount;
  } else {
    struct if_dqblk quota = {0};
    if (quota_call(descriptor, QCMD(Q_GETQUOTA, PRJQUOTA),
                   (int)project_id, &quota) != 0)
      die(errno == ENOSYS ? "project_quota_quotactl_fd_unavailable"
                          : "project_quota_kernel_capability_missing");
    state.hard_bytes = quota.dqb_bhardlimit * QIF_DQBLKSIZE;
    state.hard_inodes = quota.dqb_ihardlimit;
    state.used_bytes = quota.dqb_curspace;
    state.used_inodes = quota.dqb_curinodes;
  }
  return state;
}

static void set_quota(int descriptor, const MountIdentity *mount,
                      uint32_t project_id, uint64_t bytes, uint64_t inodes) {
  if ((strcmp(mount->filesystem, "xfs") == 0 && bytes % 512 != 0) ||
      (strcmp(mount->filesystem, "ext4") == 0 &&
       bytes % QIF_DQBLKSIZE != 0))
    die("project_quota_byte_limit_not_exactly_representable");
  if (strcmp(mount->filesystem, "xfs") == 0) {
    struct fs_disk_quota quota = {
        .d_version = FS_DQUOT_VERSION,
        .d_flags = FS_PROJ_QUOTA,
        .d_fieldmask = FS_DQ_BHARD | FS_DQ_IHARD,
        .d_id = project_id,
        .d_blk_hardlimit = bytes / 512ULL,
        .d_ino_hardlimit = inodes};
    if (quota_call(descriptor, QCMD(Q_XSETQLIM, PRJQUOTA),
                   (int)project_id, &quota) != 0)
      die("project_quota_limit_application_failed");
  } else {
    struct if_dqblk quota = {.dqb_bhardlimit = bytes / QIF_DQBLKSIZE,
                             .dqb_ihardlimit = inodes,
                             .dqb_valid = QIF_BLIMITS | QIF_ILIMITS};
    if (quota_call(descriptor, QCMD(Q_SETQUOTA, PRJQUOTA),
                   (int)project_id, &quota) != 0)
      die("project_quota_limit_application_failed");
  }
}

static uint32_t read_project_id(int descriptor, int *inherited) {
  struct fsxattr attributes = {0};
  if (ioctl(descriptor, FS_IOC_FSGETXATTR, &attributes) != 0)
    die("project_quota_identity_read_failed");
  *inherited = (attributes.fsx_xflags & FS_XFLAG_PROJINHERIT) != 0;
  return attributes.fsx_projid;
}

static void set_project_id(int descriptor, uint32_t project_id, int inherit) {
  struct fsxattr attributes = {0};
  if (ioctl(descriptor, FS_IOC_FSGETXATTR, &attributes) != 0)
    die("project_quota_identity_read_failed");
  attributes.fsx_projid = project_id;
  if (inherit)
    attributes.fsx_xflags |= FS_XFLAG_PROJINHERIT;
  else
    attributes.fsx_xflags &= ~FS_XFLAG_PROJINHERIT;
  if (ioctl(descriptor, FS_IOC_FSSETXATTR, &attributes) != 0)
    die("project_quota_identity_application_failed");
}

static Request parse_request(int argc, char **argv) {
  if (argc < 17)
    die("project_quota_request_arity");
  Request request = {0};
  if (!safe_allocation_id(argv[4]) || !safe_identifier(argv[10], 256))
    die("project_quota_request_identity_invalid");
  snprintf(request.allocation_id, sizeof(request.allocation_id), "%s", argv[4]);
  uint64_t project_id = unsigned_number(argv[5]);
  if (project_id < 1 || project_id > INT_MAX)
    die("project_quota_project_id_invalid");
  request.project_id = (uint32_t)project_id;
  request.maximum_bytes = unsigned_number(argv[6]);
  request.inode_maximum = unsigned_number(argv[7]);
  if (request.maximum_bytes < 1 || request.inode_maximum < 1)
    die("project_quota_limit_invalid");
  exact_digest(argv[8], "project_quota_control_digest_invalid");
  if (strlen(argv[9]) != 73 || strncmp(argv[9], "fence-v1-", 9) != 0)
    die("project_quota_fence_fingerprint_invalid");
  exact_digest(argv[9] + 9, "project_quota_fence_fingerprint_invalid");
  snprintf(request.control_digest, sizeof(request.control_digest), "%s", argv[8]);
  snprintf(request.fence_fingerprint, sizeof(request.fence_fingerprint), "%s",
           argv[9]);
  snprintf(request.execution_generation, sizeof(request.execution_generation),
           "%s", argv[10]);
  request.cluster_version = unsigned_number(argv[11]);
  request.writer_epoch = unsigned_number(argv[12]);
  request.gate_revision = unsigned_number(argv[13]);
  request.owner_fence = unsigned_number(argv[14]);
  request.desired_version = unsigned_number(argv[15]);
  request.start_revocation = unsigned_number(argv[16]);
  if (snprintf(request.root, sizeof(request.root), "%s/%s", argv[2], argv[4]) >=
      (int)sizeof(request.root))
    die("project_quota_root_path_too_long");
  return request;
}

static int same_request(const Request *left, const Request *right) {
  return strcmp(left->allocation_id, right->allocation_id) == 0 &&
         left->project_id == right->project_id &&
         strcmp(left->root, right->root) == 0 &&
         left->maximum_bytes == right->maximum_bytes &&
         left->inode_maximum == right->inode_maximum &&
         strcmp(left->control_digest, right->control_digest) == 0 &&
         strcmp(left->execution_generation, right->execution_generation) == 0;
}

static int same_mount(const MountIdentity *left, const MountIdentity *right) {
  return left->mount_id == right->mount_id &&
         left->device_major == right->device_major &&
         left->device_minor == right->device_minor &&
         strcmp(left->filesystem, right->filesystem) == 0 &&
         strcmp(left->mount_option, right->mount_option) == 0 &&
         strcmp(left->boot_id, right->boot_id) == 0;
}

static int same_stable_mount(const MountIdentity *left,
                             const MountIdentity *right) {
  return left->device_major == right->device_major &&
         left->device_minor == right->device_minor &&
         strcmp(left->filesystem, right->filesystem) == 0 &&
         strcmp(left->mount_option, right->mount_option) == 0;
}

static int newer_authority(const Request *request, const Request *existing) {
  if (request->cluster_version < existing->cluster_version ||
      request->writer_epoch < existing->writer_epoch ||
      request->owner_fence < existing->owner_fence ||
      request->gate_revision < existing->gate_revision ||
      request->desired_version < existing->desired_version ||
      request->start_revocation < existing->start_revocation)
    die("project_quota_stale_mutation_fence");
  if (strcmp(request->fence_fingerprint, existing->fence_fingerprint) == 0)
    return 0;
  if (request->cluster_version == existing->cluster_version &&
      request->writer_epoch == existing->writer_epoch &&
      request->owner_fence == existing->owner_fence &&
      request->gate_revision == existing->gate_revision &&
      request->desired_version == existing->desired_version &&
      request->start_revocation == existing->start_revocation)
    die("project_quota_equal_fence_tuple_mismatch");
  return 1;
}

static int receipt_line(const Receipt *receipt, char *output, size_t capacity,
                        int checksum) {
  return snprintf(
      output, capacity,
      "%s\t%s\t%s\t%u\t%s\t%llu\t%llu\t%s\t%s\t%s\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%s\t%s\t%u\t%llu\t%llu\t%llu\t%s\t%s\t%s%s%s\n",
      RECEIPT_SCHEMA, receipt->status, receipt->request.allocation_id,
      receipt->request.project_id, receipt->request.root,
      (unsigned long long)receipt->request.maximum_bytes,
      (unsigned long long)receipt->request.inode_maximum,
      receipt->request.control_digest, receipt->request.fence_fingerprint,
      receipt->request.execution_generation,
      (unsigned long long)receipt->request.cluster_version,
      (unsigned long long)receipt->request.writer_epoch,
      (unsigned long long)receipt->request.gate_revision,
      (unsigned long long)receipt->request.owner_fence,
      (unsigned long long)receipt->request.desired_version,
      (unsigned long long)receipt->request.start_revocation,
      (unsigned long long)receipt->root_major,
      (unsigned long long)receipt->root_minor,
      (unsigned long long)receipt->root_inode,
      (unsigned long long)receipt->mount.mount_id, receipt->mount.filesystem,
      receipt->mount.mount_option, receipt->applied_project_id,
      (unsigned long long)receipt->effective_bytes,
      (unsigned long long)receipt->effective_inodes,
      (unsigned long long)receipt->revision, receipt->mount.boot_id,
      VERIFICATION, receipt->prior_checksum,
      checksum ? "\t" : "", checksum ? receipt->checksum : "");
}

static void checksum_receipt(Receipt *receipt) {
  char line[MAX_RECEIPT_SIZE];
  int length = receipt_line(receipt, line, sizeof(line), 0);
  if (length < 1 || (size_t)length >= sizeof(line))
    die("project_quota_receipt_too_large");
  wf_sha256(line, (size_t)length, receipt->checksum);
}

static void write_all(int descriptor, const char *data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, data + offset, length - offset);
    if (written <= 0)
      die("project_quota_receipt_write_failed");
    offset += (size_t)written;
  }
}

static void receipt_name(const char *allocation_id, char output[160]) {
  if (snprintf(output, 160, "%s.receipt", allocation_id) >= 160)
    die("project_quota_receipt_name_too_long");
}

static void persist_receipt(int directory, Receipt *receipt) {
  char final_name[160], temporary[192], line[MAX_RECEIPT_SIZE];
  receipt_name(receipt->request.allocation_id, final_name);
  if (snprintf(temporary, sizeof(temporary), ".%s.%ld.tmp", final_name,
               (long)getpid()) >= (int)sizeof(temporary))
    die("project_quota_receipt_name_too_long");
  checksum_receipt(receipt);
  int length = receipt_line(receipt, line, sizeof(line), 1);
  if (length < 1 || (size_t)length >= sizeof(line))
    die("project_quota_receipt_too_large");
  int descriptor = openat(directory, temporary,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                          0600);
  if (descriptor < 0)
    die("project_quota_receipt_temporary_create_failed");
  write_all(descriptor, line, (size_t)length);
  if (fsync(descriptor) != 0 || close(descriptor) != 0)
    die("project_quota_receipt_fsync_failed");
  if (renameat(directory, temporary, directory, final_name) != 0 ||
      fsync(directory) != 0)
    die("project_quota_receipt_commit_failed");
}

static char *next_field(char **cursor) {
  char *field = strsep(cursor, "\t");
  if (field == NULL || strchr(field, '\n') != NULL)
    die("project_quota_receipt_corrupt");
  return field;
}

static int load_receipt(int directory, const char *allocation_id,
                        Receipt *receipt) {
  char name[160], buffer[MAX_RECEIPT_SIZE + 1];
  receipt_name(allocation_id, name);
  int descriptor = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT)
      return 0;
    die("project_quota_receipt_open_failed");
  }
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_uid != 0 || metadata.st_gid != 0 ||
      (metadata.st_mode & 0077) != 0 || metadata.st_nlink != 1 ||
      metadata.st_size < 1 || metadata.st_size > MAX_RECEIPT_SIZE)
    die("project_quota_receipt_identity_untrusted");
  ssize_t length = read(descriptor, buffer, sizeof(buffer) - 1);
  if (length != metadata.st_size || close(descriptor) != 0)
    die("project_quota_receipt_read_failed");
  buffer[length] = '\0';
  if (buffer[length - 1] != '\n')
    die("project_quota_receipt_corrupt");
  buffer[length - 1] = '\0';
  char *cursor = buffer;
  if (strcmp(next_field(&cursor), RECEIPT_SCHEMA) != 0)
    die("project_quota_receipt_schema_mismatch");
  snprintf(receipt->status, sizeof(receipt->status), "%s", next_field(&cursor));
  snprintf(receipt->request.allocation_id,
           sizeof(receipt->request.allocation_id), "%s", next_field(&cursor));
  receipt->request.project_id = (uint32_t)unsigned_number(next_field(&cursor));
  snprintf(receipt->request.root, sizeof(receipt->request.root), "%s",
           next_field(&cursor));
  receipt->request.maximum_bytes = unsigned_number(next_field(&cursor));
  receipt->request.inode_maximum = unsigned_number(next_field(&cursor));
  snprintf(receipt->request.control_digest,
           sizeof(receipt->request.control_digest), "%s", next_field(&cursor));
  snprintf(receipt->request.fence_fingerprint,
           sizeof(receipt->request.fence_fingerprint), "%s",
           next_field(&cursor));
  snprintf(receipt->request.execution_generation,
           sizeof(receipt->request.execution_generation), "%s",
           next_field(&cursor));
  receipt->request.cluster_version = unsigned_number(next_field(&cursor));
  receipt->request.writer_epoch = unsigned_number(next_field(&cursor));
  receipt->request.gate_revision = unsigned_number(next_field(&cursor));
  receipt->request.owner_fence = unsigned_number(next_field(&cursor));
  receipt->request.desired_version = unsigned_number(next_field(&cursor));
  receipt->request.start_revocation = unsigned_number(next_field(&cursor));
  receipt->root_major = unsigned_number(next_field(&cursor));
  receipt->root_minor = unsigned_number(next_field(&cursor));
  if (receipt->root_major > UINT_MAX || receipt->root_minor > UINT_MAX)
    die("project_quota_receipt_device_invalid");
  receipt->mount.device_major = (unsigned int)receipt->root_major;
  receipt->mount.device_minor = (unsigned int)receipt->root_minor;
  receipt->root_inode = unsigned_number(next_field(&cursor));
  receipt->mount.mount_id = unsigned_number(next_field(&cursor));
  snprintf(receipt->mount.filesystem, sizeof(receipt->mount.filesystem), "%s",
           next_field(&cursor));
  snprintf(receipt->mount.mount_option, sizeof(receipt->mount.mount_option),
           "%s", next_field(&cursor));
  receipt->applied_project_id = (uint32_t)unsigned_number(next_field(&cursor));
  receipt->effective_bytes = unsigned_number(next_field(&cursor));
  receipt->effective_inodes = unsigned_number(next_field(&cursor));
  receipt->revision = unsigned_number(next_field(&cursor));
  snprintf(receipt->mount.boot_id, sizeof(receipt->mount.boot_id), "%s",
           next_field(&cursor));
  if (strcmp(next_field(&cursor), VERIFICATION) != 0)
    die("project_quota_receipt_verification_mismatch");
  snprintf(receipt->prior_checksum, sizeof(receipt->prior_checksum), "%s",
           next_field(&cursor));
  snprintf(receipt->checksum, sizeof(receipt->checksum), "%s",
           next_field(&cursor));
  if (cursor != NULL)
    die("project_quota_receipt_field_ambiguity");
  if (strcmp(receipt->status, "prepared") != 0 &&
      strcmp(receipt->status, "active") != 0 &&
      strcmp(receipt->status, "prepared_removal") != 0 &&
      strcmp(receipt->status, "removed") != 0)
    die("project_quota_receipt_status_invalid");
  exact_digest(receipt->prior_checksum,
               "project_quota_receipt_prior_checksum_invalid");
  exact_digest(receipt->checksum, "project_quota_receipt_checksum_invalid");
  char expected[65];
  Receipt copy = *receipt;
  checksum_receipt(&copy);
  snprintf(expected, sizeof(expected), "%s", copy.checksum);
  if (strcmp(expected, receipt->checksum) != 0)
    die("project_quota_receipt_checksum_mismatch");
  if (strcmp(receipt->request.allocation_id, allocation_id) != 0)
    die("project_quota_receipt_allocation_mismatch");
  return 1;
}

static void reject_project_collision(int receipt_root, const Request *request) {
  int copy = dup(receipt_root);
  DIR *directory = copy < 0 ? NULL : fdopendir(copy);
  if (directory == NULL)
    die("project_quota_registry_scan_failed");
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    size_t length = strlen(entry->d_name);
    if (length <= 8 || strcmp(entry->d_name + length - 8, ".receipt") != 0)
      continue;
    char allocation[129];
    if (length - 8 >= sizeof(allocation))
      die("project_quota_registry_entry_invalid");
    memcpy(allocation, entry->d_name, length - 8);
    allocation[length - 8] = '\0';
    if (!safe_allocation_id(allocation))
      die("project_quota_registry_entry_invalid");
    Receipt existing = {0};
    if (!load_receipt(receipt_root, allocation, &existing))
      die("project_quota_registry_race");
    if (strcmp(existing.status, "removed") != 0 &&
        existing.request.project_id == request->project_id &&
        strcmp(existing.request.allocation_id, request->allocation_id) != 0)
      die("project_quota_project_id_collision");
  }
  if (errno != 0 || closedir(directory) != 0)
    die("project_quota_registry_scan_failed");
}

static void verify_named_root(int parent, const char *name, int descriptor,
                              const struct stat *expected) {
  struct stat named, current;
  if (fstat(descriptor, &current) != 0 ||
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(named.st_mode) || named.st_dev != expected->st_dev ||
      named.st_ino != expected->st_ino || current.st_dev != expected->st_dev ||
      current.st_ino != expected->st_ino)
    die("project_quota_workspace_identity_changed");
}

static void verify_no_descendant_mounts(const char *root) {
  FILE *mounts = fopen("/proc/self/mountinfo", "re");
  if (mounts == NULL)
    die("project_quota_mountinfo_unavailable");
  char *line = NULL;
  size_t capacity = 0;
  size_t root_length = strlen(root);
  int found = 0;
  while (getline(&line, &capacity, mounts) >= 0) {
    char *copy = strdup(line), *save = NULL, *tokens[8];
    size_t count = 0;
    if (copy == NULL)
      die("project_quota_out_of_memory");
    for (char *token = strtok_r(copy, " \n", &save);
         token != NULL && count < 8;
         token = strtok_r(NULL, " \n", &save))
      tokens[count++] = token;
    if (count >= 5 && strncmp(tokens[4], root, root_length) == 0 &&
        tokens[4][root_length] == '/')
      found = 1;
    free(copy);
    if (found)
      break;
  }
  free(line);
  if (ferror(mounts) != 0 || fclose(mounts) != 0)
    die("project_quota_mountinfo_unavailable");
  if (found)
    die("project_quota_descendant_mount_present");
}

static void test_crash_point(const char *point) {
#ifdef WF_PROJECT_QUOTA_TEST_ROOTS
  const char *requested = getenv("WF_PROJECT_QUOTA_TEST_CRASH_POINT");
  if (requested != NULL && strcmp(requested, point) == 0)
    _exit(86);
#else
  (void)point;
#endif
}

static void verify_effective(int target, int parent, const Request *request,
                             const Receipt *receipt,
                             const struct stat *root_metadata,
                             const MountIdentity *mount) {
  verify_named_root(parent, request->allocation_id, target, root_metadata);
  MountIdentity current_mount = mount_identity(target);
  if (!same_mount(mount, &current_mount) ||
      receipt->root_major != major(root_metadata->st_dev) ||
      receipt->root_minor != minor(root_metadata->st_dev) ||
      receipt->root_inode != (uint64_t)root_metadata->st_ino)
    die("project_quota_mount_or_inode_drift");
  int inherited = 0;
  uint32_t project_id = read_project_id(target, &inherited);
  QuotaState quota = read_quota(target, mount, request->project_id);
  if (project_id != request->project_id || !inherited ||
      quota.hard_bytes != request->maximum_bytes ||
      quota.hard_inodes != request->inode_maximum ||
      receipt->applied_project_id != request->project_id ||
      receipt->effective_bytes != request->maximum_bytes ||
      receipt->effective_inodes != request->inode_maximum)
    die("project_quota_effective_limit_drift");
}

static Receipt base_receipt(const Request *request, const struct stat *metadata,
                            const MountIdentity *mount, uint64_t revision,
                            const char *status) {
  Receipt receipt = {.request = *request,
                     .root_major = major(metadata->st_dev),
                     .root_minor = minor(metadata->st_dev),
                     .root_inode = (uint64_t)metadata->st_ino,
                     .mount = *mount,
                     .applied_project_id = request->project_id,
                     .effective_bytes = request->maximum_bytes,
                     .effective_inodes = request->inode_maximum,
                     .revision = revision};
  snprintf(receipt.prior_checksum, sizeof(receipt.prior_checksum), "%s",
           NO_PRIOR_CHECKSUM);
  snprintf(receipt.status, sizeof(receipt.status), "%s", status);
  return receipt;
}

static void verify_registry_mount(int receipt_root,
                                  const MountIdentity *allocation_mount) {
  MountIdentity receipt_mount = mount_identity(receipt_root);
  if (!same_mount(allocation_mount, &receipt_mount))
    die("project_quota_receipt_root_mount_mismatch");
}

static int accepted_removal_digest(const Receipt *receipt,
                                   const char *digest) {
  if (strcmp(receipt->checksum, digest) == 0)
    return 1;
  return strcmp(receipt->prior_checksum, NO_PRIOR_CHECKSUM) != 0 &&
         (strcmp(receipt->status, "prepared_removal") == 0 ||
          strcmp(receipt->status, "removed") == 0) &&
         strcmp(receipt->prior_checksum, digest) == 0;
}

static void reconcile_prepared_removal(int target, int parent,
                                       const Request *request,
                                       const struct stat *metadata,
                                       const MountIdentity *mount) {
  verify_named_root(parent, request->allocation_id, target, metadata);
  MountIdentity current_mount = mount_identity(target);
  if (!same_mount(mount, &current_mount))
    die("project_quota_mount_or_inode_drift");
  int inherited = 0;
  uint32_t project_id = read_project_id(target, &inherited);
  QuotaState quota = read_quota(target, mount, request->project_id);
  int identity_active = project_id == request->project_id && inherited;
  int identity_cleared = project_id == 0 && !inherited;
  int quota_active = quota.hard_bytes == request->maximum_bytes &&
                     quota.hard_inodes == request->inode_maximum;
  int quota_cleared = quota.hard_bytes == 0 && quota.hard_inodes == 0;
  if ((!identity_active && !identity_cleared) ||
      (!quota_active && !quota_cleared))
    die("project_quota_prepared_removal_state_invalid");
  if (identity_active)
    set_project_id(target, 0, 0);
  test_crash_point("after_project_identity_cleared");
  if (quota_active)
    set_quota(target, mount, request->project_id, 0, 0);
  test_crash_point("after_quota_cleared");
  inherited = 1;
  project_id = read_project_id(target, &inherited);
  QuotaState cleared = read_quota(target, mount, request->project_id);
  if (project_id != 0 || inherited || cleared.hard_bytes != 0 ||
      cleared.hard_inodes != 0)
    die("project_quota_removal_verification_failed");
}

static void print_result(const char *operation, const Receipt *receipt) {
  char line[MAX_RECEIPT_SIZE];
  int length = receipt_line(receipt, line, sizeof(line), 1);
  if (length < 1 || (size_t)length >= sizeof(line))
    die("project_quota_receipt_too_large");
  line[length - 1] = '\0';
  printf("result\t%s\t%s\n", operation, line);
}

static void probe_command(int argc, char **argv) {
  if (argc != 4)
    die("project_quota_probe_arity");
  int allocations = open_trusted_root(argv[2], PRODUCTION_ALLOCATION_ROOT);
  int receipts = open_trusted_root(argv[3], PRODUCTION_RECEIPT_ROOT);
  MountIdentity mount = mount_identity(allocations);
  verify_registry_mount(receipts, &mount);
  verify_quota_active(allocations, &mount);
  (void)read_quota(allocations, &mount, 0);
  struct stat metadata;
  if (fstat(allocations, &metadata) != 0)
    die("project_quota_mount_identity_unavailable");
#ifdef WF_PROJECT_QUOTA_TEST_ROOTS
  const char *mode = "disposable-test";
#else
  const char *mode = "production";
#endif
  printf("%s\t%s\t%llu\t%u:%u\t%s\t%s\t%s\ttrue\ttrue\n",
         CAPABILITY_SCHEMA, mode, (unsigned long long)mount.mount_id,
         mount.device_major, mount.device_minor, mount.filesystem,
         mount.mount_option, mount.boot_id);
  close(receipts);
  close(allocations);
}

static void application_command(int argc, char **argv, const char *command) {
  int verify_only = strcmp(command, "verify") == 0;
  int cleanup = strcmp(command, "cleanup") == 0;
  int remove = strcmp(command, "remove") == 0;
  int destructive = cleanup || remove;
  if ((!verify_only && !remove && !cleanup && argc != 17) ||
      (cleanup && argc != 17) ||
      ((verify_only || remove) && argc != 18))
    die("project_quota_request_arity");
  Request request = parse_request(argc, argv);
  if (verify_only || remove)
    exact_digest(argv[17], "project_quota_expected_receipt_digest_invalid");
  int allocation_root = open_trusted_root(argv[2], PRODUCTION_ALLOCATION_ROOT);
  int receipt_root = open_trusted_root(argv[3], PRODUCTION_RECEIPT_ROOT);
  int lock = openat(receipt_root, ".registry.lock",
                    O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (lock < 0 || flock(lock, LOCK_EX) != 0)
    die("project_quota_registry_lock_failed");
  int target = open_resolved(
      allocation_root, request.allocation_id, O_RDONLY | O_DIRECTORY,
      RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
          RESOLVE_NO_XDEV);
  struct stat metadata;
  if (target < 0 || fstat(target, &metadata) != 0 ||
      !S_ISDIR(metadata.st_mode))
    die("project_quota_workspace_open_refused");
  MountIdentity mount = mount_identity(target);
  verify_registry_mount(receipt_root, &mount);
  verify_no_descendant_mounts(request.root);
  verify_quota_active(target, &mount);
  Receipt existing = {0};
  int present = load_receipt(receipt_root, request.allocation_id, &existing);
  if (cleanup && !present) {
    int inherited = 1;
    uint32_t project_id = read_project_id(target, &inherited);
    QuotaState quota = read_quota(target, &mount, request.project_id);
    if (project_id != 0 || inherited || quota.hard_bytes != 0 ||
        quota.hard_inodes != 0 || quota.used_bytes != 0 ||
        quota.used_inodes != 0)
      die("project_quota_unregistered_cleanup_refused");
    printf("result\tabsent\n");
    close(target);
    close(lock);
    close(receipt_root);
    close(allocation_root);
    return;
  }
  int mount_compatible =
      !present || same_mount(&mount, &existing.mount) ||
      (destructive && same_stable_mount(&mount, &existing.mount));
  if (present && (!same_request(&request, &existing.request) ||
                  !mount_compatible ||
                  existing.root_major != major(metadata.st_dev) ||
                  existing.root_minor != minor(metadata.st_dev) ||
                  existing.root_inode != (uint64_t)metadata.st_ino))
    die("project_quota_receipt_tuple_mismatch");
  int authority_advanced = 0;
  if (present)
    authority_advanced = newer_authority(&request, &existing.request);
  if (present && strcmp(existing.status, "removed") == 0) {
    if (!destructive ||
        (remove && strcmp(request.fence_fingerprint,
                          existing.request.fence_fingerprint) != 0))
      die("project_quota_removed_receipt_reuse");
    if (remove && !accepted_removal_digest(&existing, argv[17]))
      die("project_quota_expected_receipt_mismatch");
    int inherited = 1;
    uint32_t project_id = read_project_id(target, &inherited);
    QuotaState cleared = read_quota(target, &mount, request.project_id);
    if (project_id != 0 || inherited || cleared.hard_bytes != 0 ||
        cleared.hard_inodes != 0)
      die("project_quota_removed_receipt_drift");
    if (!same_mount(&mount, &existing.mount) ||
        (cleanup && authority_advanced)) {
      if (cleanup && authority_advanced)
        existing.request = request;
      existing.mount = mount;
      existing.revision++;
      persist_receipt(receipt_root, &existing);
    }
    print_result("removed", &existing);
    close(target);
    close(lock);
    close(receipt_root);
    close(allocation_root);
    return;
  }
  if (verify_only &&
      (!present || strcmp(existing.status, "active") != 0 ||
       strcmp(existing.checksum, argv[17]) != 0))
    die("project_quota_expected_receipt_mismatch");
  if (remove &&
      (!present ||
       (strcmp(existing.status, "active") != 0 &&
        strcmp(existing.status, "prepared_removal") != 0) ||
       !accepted_removal_digest(&existing, argv[17])))
    die("project_quota_expected_receipt_mismatch");
  if (cleanup &&
      (!present ||
       (strcmp(existing.status, "prepared") != 0 &&
        strcmp(existing.status, "active") != 0 &&
        strcmp(existing.status, "prepared_removal") != 0)))
    die("project_quota_cleanup_receipt_state_invalid");
  if (!destructive && present &&
      strcmp(existing.status, "prepared_removal") == 0)
    die("project_quota_removal_in_progress");

  if (verify_only) {
    verify_effective(target, allocation_root, &request, &existing, &metadata,
                     &mount);
    print_result("verified_existing", &existing);
  } else if (destructive) {
    if (strcmp(existing.status, "active") == 0) {
      Receipt current = existing;
      current.mount = mount;
      verify_effective(target, allocation_root, &request, &current, &metadata,
                       &mount);
      snprintf(existing.prior_checksum, sizeof(existing.prior_checksum), "%s",
               existing.checksum);
    } else if (strcmp(existing.status, "prepared") == 0) {
      snprintf(existing.prior_checksum, sizeof(existing.prior_checksum), "%s",
               existing.checksum);
    }
    if (strcmp(request.fence_fingerprint,
               existing.request.fence_fingerprint) != 0 ||
        !same_mount(&mount, &existing.mount) ||
        strcmp(existing.status, "prepared_removal") != 0) {
      existing.request = request;
      existing.mount = mount;
      existing.revision++;
      snprintf(existing.status, sizeof(existing.status), "prepared_removal");
      persist_receipt(receipt_root, &existing);
    }
    test_crash_point("after_prepared_removal");
    reconcile_prepared_removal(target, allocation_root, &request, &metadata,
                               &mount);
    existing.revision++;
    snprintf(existing.status, sizeof(existing.status), "removed");
    existing.applied_project_id = 0;
    existing.effective_bytes = 0;
    existing.effective_inodes = 0;
    persist_receipt(receipt_root, &existing);
    test_crash_point("after_removed_receipt");
    print_result("removed", &existing);
  } else if (present && strcmp(existing.status, "active") == 0) {
    verify_effective(target, allocation_root, &request, &existing, &metadata,
                     &mount);
    if (strcmp(request.fence_fingerprint,
               existing.request.fence_fingerprint) != 0) {
      existing.request = request;
      existing.revision++;
      persist_receipt(receipt_root, &existing);
    }
    print_result("verified_existing", &existing);
  } else {
    reject_project_collision(receipt_root, &request);
    int inherited = 0;
    uint32_t current_project = read_project_id(target, &inherited);
    QuotaState before = read_quota(target, &mount, request.project_id);
    if (current_project != 0 && current_project != request.project_id)
      die("project_quota_workspace_project_id_collision");
    if (!present && (before.hard_bytes != 0 || before.hard_inodes != 0 ||
                     before.used_bytes != 0 || before.used_inodes != 0))
      die("project_quota_unregistered_kernel_id_collision");
    uint64_t revision = present ? existing.revision : 0;
    Receipt prepared = base_receipt(&request, &metadata, &mount, revision + 1,
                                    "prepared");
    if (!present)
      persist_receipt(receipt_root, &prepared);
    else
      prepared = existing;
    test_crash_point("after_prepared_application_receipt");
    if (current_project == 0 || !inherited)
      set_project_id(target, request.project_id, 1);
    test_crash_point("after_project_identity_applied");
    set_quota(target, &mount, request.project_id, request.maximum_bytes,
              request.inode_maximum);
    test_crash_point("after_quota_applied");
    Receipt applied = base_receipt(&request, &metadata, &mount,
                                   prepared.revision + 1, "active");
    verify_named_root(allocation_root, request.allocation_id, target, &metadata);
    int applied_inherit = 0;
    uint32_t applied_id = read_project_id(target, &applied_inherit);
    QuotaState effective = read_quota(target, &mount, request.project_id);
    if (applied_id != request.project_id || !applied_inherit ||
        effective.hard_bytes != request.maximum_bytes ||
        effective.hard_inodes != request.inode_maximum)
      die("project_quota_application_verification_failed");
    persist_receipt(receipt_root, &applied);
    Receipt reopened = {0};
    if (!load_receipt(receipt_root, request.allocation_id, &reopened) ||
        strcmp(reopened.checksum, applied.checksum) != 0)
      die("project_quota_receipt_reopen_failed");
    verify_effective(target, allocation_root, &request, &reopened, &metadata,
                     &mount);
    print_result("applied", &reopened);
  }
  close(target);
  close(lock);
  close(receipt_root);
  close(allocation_root);
}

int main(int argc, char **argv) {
  if (argc < 2)
    die("project_quota_command_missing");
  if (strcmp(argv[1], "probe") == 0)
    probe_command(argc, argv);
  else if (strcmp(argv[1], "apply") == 0 ||
           strcmp(argv[1], "verify") == 0 ||
           strcmp(argv[1], "remove") == 0 ||
           strcmp(argv[1], "cleanup") == 0)
    application_command(argc, argv, argv[1]);
  else
    die("project_quota_command_unknown");
  return 0;
}
