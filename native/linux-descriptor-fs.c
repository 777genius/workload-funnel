#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

typedef struct { uint32_t h[8]; uint64_t bits; unsigned char block[64]; size_t used; } Sha256;
#ifdef WF_RESULT_SEALER_ONLY
typedef struct {
  char *path;
  char type;
  struct stat metadata;
  char digest[65];
} Entry;
typedef struct { Entry *items; size_t length; size_t capacity; } Entries;
typedef struct { size_t depth, entries, observed_entries; off_t file_bytes, max_total_bytes, observed_bytes; uid_t uid; dev_t device; } Limits;
#endif

static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};
static uint32_t rr(uint32_t x, unsigned n){ return (x>>n)|(x<<(32-n)); }
static void sha_block(Sha256 *s,const unsigned char *p){
  uint32_t w[64],a,b,c,d,e,f,g,h;
  for(int i=0;i<16;i++) w[i]=((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];
  for(int i=16;i<64;i++){ uint32_t x=w[i-15],y=w[i-2]; w[i]=(rr(y,17)^rr(y,19)^(y>>10))+w[i-7]+(rr(x,7)^rr(x,18)^(x>>3))+w[i-16]; }
  a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
  for(int i=0;i<64;i++){ uint32_t t1=h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^((~e)&g))+K[i]+w[i]; uint32_t t2=(rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)); h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
  s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(Sha256 *s){ uint32_t h[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}; memcpy(s->h,h,sizeof h);s->bits=0;s->used=0; }
static void sha_add(Sha256 *s,const void *data,size_t n){ const unsigned char *p=data;s->bits+=(uint64_t)n*8;while(n){size_t take=64-s->used;if(take>n)take=n;memcpy(s->block+s->used,p,take);s->used+=take;p+=take;n-=take;if(s->used==64){sha_block(s,s->block);s->used=0;}} }
static void sha_done(Sha256 *s,char out[65]){ uint64_t bits=s->bits;s->block[s->used++]=0x80;if(s->used>56){while(s->used<64)s->block[s->used++]=0;sha_block(s,s->block);s->used=0;}while(s->used<56)s->block[s->used++]=0;for(int i=7;i>=0;i--)s->block[s->used++]=(unsigned char)(bits>>(i*8));sha_block(s,s->block);for(int i=0;i<8;i++)sprintf(out+i*8,"%08x",s->h[i]);out[64]=0; }

static void die(const char *reason){ fprintf(stderr,"%s\n",reason); exit(2); }
static long number(const char *value){ char *end=NULL;errno=0;long n=strtol(value,&end,10);if(errno||!end||*end)die("invalid_number");return n; }
static int safe_name(const char *s){ return s[0] && strcmp(s,".") && strcmp(s,"..") && !strchr(s,'/') && !strchr(s,'\\'); }
static int open_beneath(int parent,const char *path,int flags,mode_t mode){
  struct open_how how={.flags=(uint64_t)(flags|O_CLOEXEC|O_NOFOLLOW),.mode=mode,.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
  return (int)syscall(SYS_openat2,parent,path,&how,sizeof how);
}
static int open_root(const char *path,struct stat *metadata){ int fd=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);if(fd<0||fstat(fd,metadata)||!S_ISDIR(metadata->st_mode))die("unsafe_root");if(metadata->st_mode&0022)die("writable_root");return fd; }
#ifdef WF_RESULT_SEALER_ONLY
static int same_stat(const struct stat *a,const struct stat *b){ return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_mode==b->st_mode&&a->st_nlink==b->st_nlink&&a->st_size==b->st_size&&a->st_mtim.tv_sec==b->st_mtim.tv_sec&&a->st_mtim.tv_nsec==b->st_mtim.tv_nsec&&a->st_ctim.tv_sec==b->st_ctim.tv_sec&&a->st_ctim.tv_nsec==b->st_ctim.tv_nsec; }
#endif
static void hash_fd(int fd,char digest[65]){ unsigned char buf[65536];ssize_t n;Sha256 s;sha_init(&s);if(lseek(fd,0,SEEK_SET)<0)die("seek_failed");while((n=read(fd,buf,sizeof buf))>0)sha_add(&s,buf,(size_t)n);if(n<0)die("read_failed");sha_done(&s,digest); }
#ifdef WF_RESULT_SEALER_ONLY
static void add_entry(Entries *all,const char *path,char type,const struct stat *st,const char *digest){ if(all->length==all->capacity){all->capacity=all->capacity?all->capacity*2:32;all->items=realloc(all->items,all->capacity*sizeof *all->items);if(!all->items)die("out_of_memory");}Entry *e=&all->items[all->length++];e->path=strdup(path);e->type=type;e->metadata=*st;if(digest)memcpy(e->digest,digest,65);else e->digest[0]=0; }
static int entry_compare(const void *a,const void *b){ return strcmp(((const Entry*)a)->path,((const Entry*)b)->path); }
static void scan_dir(int fd,const char *prefix,size_t depth,Limits *limits,Entries *all){
  if(depth>limits->depth){die("depth_limit");}int copy=dup(fd);if(copy<0)die("dup_failed");DIR *directory=fdopendir(copy);if(!directory)die("fdopendir_failed");struct dirent *item;errno=0;
  while((item=readdir(directory))){ if(!strcmp(item->d_name,".")||!strcmp(item->d_name,".."))continue;if(!safe_name(item->d_name))die("unsafe_name");if(++limits->observed_entries>limits->entries)die("entry_limit");
    size_t length=strlen(prefix)+strlen(item->d_name)+2;char *path=malloc(length);if(!path)die("out_of_memory");snprintf(path,length,"%s%s%s",prefix,prefix[0]?"/":"",item->d_name);
    int probe=open_beneath(fd,item->d_name,O_PATH,0);if(probe<0)die("openat2_refused");struct stat probed;if(fstat(probe,&probed))die("fstat_failed");if(!S_ISREG(probed.st_mode)&&!S_ISDIR(probed.st_mode))die("special_file_refused");close(probe);int child=open_beneath(fd,item->d_name,O_RDONLY,0);if(child<0)die("openat2_refused");struct stat before,after;if(fstat(child,&before))die("fstat_failed");if(before.st_dev!=limits->device||before.st_uid!=limits->uid||(before.st_mode&06000)||flistxattr(child,NULL,0)!=0)die("unsafe_metadata");
    if(S_ISREG(before.st_mode)){if(before.st_nlink!=1||before.st_size<0||before.st_size>limits->file_bytes||before.st_blocks*512<before.st_size)die("unsafe_file");if(before.st_size>limits->max_total_bytes-limits->observed_bytes)die("byte_limit");limits->observed_bytes+=before.st_size;char digest[65];hash_fd(child,digest);if(fstat(child,&after)||!same_stat(&before,&after))die("mutation_race");if(fsync(child))die("file_fsync_failed");add_entry(all,path,'f',&before,digest);
    }else if(S_ISDIR(before.st_mode)){scan_dir(child,path,depth+1,limits,all);if(fstat(child,&after)||!same_stat(&before,&after))die("mutation_race");if(fsync(child))die("directory_fsync_failed");add_entry(all,path,'d',&before,NULL);
    }else die("special_file_refused");close(child);free(path);
  }
  if(errno){die("readdir_failed");}closedir(directory);
}
static Entries snapshot(int root,const char *name,Limits limits,struct stat *root_meta){ int fd=open_beneath(root,name,O_RDONLY|O_DIRECTORY,0);if(fd<0)die("source_open_refused");if(fstat(fd,root_meta)||root_meta->st_dev!=limits.device||root_meta->st_uid!=limits.uid)die("source_identity_refused");Entries entries={0};scan_dir(fd,"",1,&limits,&entries);if(fsync(fd))die("source_fsync_failed");close(fd);qsort(entries.items,entries.length,sizeof *entries.items,entry_compare);return entries; }
static int snapshots_equal(const Entries *a,const Entries *b){if(a->length!=b->length)return 0;for(size_t i=0;i<a->length;i++){Entry *x=&a->items[i],*y=&b->items[i];if(strcmp(x->path,y->path)||x->type!=y->type||!same_stat(&x->metadata,&y->metadata)||strcmp(x->digest,y->digest))return 0;}return 1;}
static int snapshots_frozen(const Entries *a,const Entries *b){if(a->length!=b->length)return 0;for(size_t i=0;i<a->length;i++){Entry *x=&a->items[i],*y=&b->items[i];if(strcmp(x->path,y->path)||x->type!=y->type||x->metadata.st_dev!=y->metadata.st_dev||x->metadata.st_ino!=y->metadata.st_ino||x->metadata.st_uid!=y->metadata.st_uid||((x->metadata.st_mode&~0222)!=(y->metadata.st_mode))||x->metadata.st_nlink!=y->metadata.st_nlink||x->metadata.st_size!=y->metadata.st_size||x->metadata.st_blocks!=y->metadata.st_blocks||x->metadata.st_mtim.tv_sec!=y->metadata.st_mtim.tv_sec||x->metadata.st_mtim.tv_nsec!=y->metadata.st_mtim.tv_nsec||strcmp(x->digest,y->digest))return 0;}return 1;}
static void freeze_dir(int fd){int copy=dup(fd);if(copy<0)die("freeze_dup_failed");DIR *directory=fdopendir(copy);if(!directory)die("freeze_fdopendir_failed");struct dirent *item;errno=0;while((item=readdir(directory))){if(!strcmp(item->d_name,".")||!strcmp(item->d_name,".."))continue;int probe=open_beneath(fd,item->d_name,O_PATH,0);struct stat probed;if(probe<0||fstat(probe,&probed)||(!S_ISDIR(probed.st_mode)&&!S_ISREG(probed.st_mode)))die("freeze_special_file");close(probe);int child=open_beneath(fd,item->d_name,O_RDONLY,0);struct stat metadata;if(child<0||fstat(child,&metadata))die("freeze_open_failed");if(S_ISDIR(metadata.st_mode))freeze_dir(child);else if(!S_ISREG(metadata.st_mode))die("freeze_special_file");if(fchmod(child,metadata.st_mode&~0222)||fsync(child))die("freeze_failed");close(child);}if(errno)die("freeze_readdir_failed");closedir(directory);struct stat metadata;if(fstat(fd,&metadata)||fchmod(fd,metadata.st_mode&~0222)||fsync(fd))die("freeze_directory_failed");}
static void free_entries(Entries *e){for(size_t i=0;i<e->length;i++)free(e->items[i].path);free(e->items);}
static void base64url(const unsigned char *p,size_t n){static const char table[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";unsigned value=0,bits=0;for(size_t i=0;i<n;i++){value=(value<<8)|p[i];bits+=8;while(bits>=6){bits-=6;putchar(table[(value>>bits)&63]);}}if(bits)putchar(table[(value<<(6-bits))&63]);}
static void print_entries(const Entries *e){for(size_t i=0;i<e->length;i++){const Entry *x=&e->items[i];printf("%c\t",x->type);base64url((const unsigned char*)x->path,strlen(x->path));printf("\t%ju\t%ju\t%u\t%u\t%ju\t%jd\t%jd\t%jd:%ld:%ld\t%s\n",(uintmax_t)x->metadata.st_dev,(uintmax_t)x->metadata.st_ino,x->metadata.st_uid,x->metadata.st_mode,(uintmax_t)x->metadata.st_nlink,(intmax_t)x->metadata.st_size,(intmax_t)x->metadata.st_blocks*512,(intmax_t)x->metadata.st_ctim.tv_sec,x->metadata.st_ctim.tv_nsec,x->metadata.st_mtim.tv_nsec,x->digest);}}

static void scan_command(int argc,char **argv){if(argc!=11)die("scan_arity");struct stat root_meta;int root=open_root(argv[2],&root_meta);if((uintmax_t)root_meta.st_dev!=(uintmax_t)strtoull(argv[5],NULL,10)||(uintmax_t)root_meta.st_ino!=(uintmax_t)strtoull(argv[6],NULL,10)||!safe_name(argv[3]))die("root_pin_mismatch");Limits limits={.uid=(uid_t)number(argv[4]),.device=root_meta.st_dev,.depth=(size_t)number(argv[7]),.entries=(size_t)number(argv[8]),.file_bytes=(off_t)number(argv[9]),.max_total_bytes=(off_t)number(argv[10]),.observed_bytes=0};struct stat source;Entries entries=snapshot(root,argv[3],limits,&source);print_entries(&entries);free_entries(&entries);close(root);}

static void seal_command(int argc,char **argv){if(argc!=14)die("seal_arity");struct stat output_meta,staging_meta;int output=open_root(argv[2],&output_meta),staging=open_root(argv[3],&staging_meta);if(output_meta.st_dev!=staging_meta.st_dev||(uintmax_t)output_meta.st_dev!=(uintmax_t)strtoull(argv[7],NULL,10)||(uintmax_t)output_meta.st_ino!=(uintmax_t)strtoull(argv[8],NULL,10)||(uintmax_t)staging_meta.st_ino!=(uintmax_t)strtoull(argv[9],NULL,10))die("root_pin_mismatch");if(!safe_name(argv[4])||!safe_name(argv[5]))die("unsafe_seal_name");Limits limits={.uid=(uid_t)number(argv[6]),.device=output_meta.st_dev,.depth=(size_t)number(argv[10]),.entries=(size_t)number(argv[11]),.file_bytes=(off_t)number(argv[12]),.max_total_bytes=(off_t)number(argv[13]),.observed_bytes=0};struct stat first_root,second_root;Entries first=snapshot(output,argv[4],limits,&first_root);Entries second=snapshot(output,argv[4],limits,&second_root);if(!same_stat(&first_root,&second_root)||!snapshots_equal(&first,&second))die("mutation_race");struct stat named;if(fstatat(output,argv[4],&named,AT_SYMLINK_NOFOLLOW)||named.st_ino!=second_root.st_ino||named.st_dev!=second_root.st_dev)die("source_swap");if(syscall(SYS_renameat2,output,argv[4],staging,argv[5],RENAME_NOREPLACE))die(errno==EEXIST?"destination_exists":"renameat2_failed");if(fsync(output)||fsync(staging))die("rename_fsync_failed");int staged_fd=open_beneath(staging,argv[5],O_RDONLY|O_DIRECTORY,0);if(staged_fd<0)die("staged_open_failed");freeze_dir(staged_fd);close(staged_fd);struct stat staged_root;Entries staged=snapshot(staging,argv[5],limits,&staged_root);if(staged_root.st_ino!=second_root.st_ino||!snapshots_frozen(&second,&staged))die("post_rename_mutation");print_entries(&second);free_entries(&first);free_entries(&second);free_entries(&staged);close(output);close(staging);}
#endif

#ifdef WF_ARTIFACT_STORE_ONLY
static int walk_parent(int root,const char *relative,int create,char **leaf){char *copy=strdup(relative);if(!copy)die("out_of_memory");char *last=strrchr(copy,'/');*leaf=strdup(last?last+1:copy);if(!safe_name(*leaf))die("unsafe_relative_path");int current=dup(root);if(last){*last=0;char *save=NULL;for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save)){if(!safe_name(part))die("unsafe_relative_path");if(create&&mkdirat(current,part,0700)&&errno!=EEXIST)die("mkdirat_failed");int next=open_beneath(current,part,O_RDONLY|O_DIRECTORY,0);if(next<0)die("parent_open_refused");if(create&&fsync(current))die("parent_fsync_failed");close(current);current=next;}}free(copy);return current;}
static int artifact_root(const char *path,const char *device,const char *inode){struct stat metadata;int root=open_root(path,&metadata);if((uintmax_t)metadata.st_dev!=(uintmax_t)strtoull(device,NULL,10)||(uintmax_t)metadata.st_ino!=(uintmax_t)strtoull(inode,NULL,10))die("artifact_root_pin_mismatch");return root;}
static void prepare_stage(int argc,char **argv){if(argc!=6)die("prepare_stage_arity");int root=artifact_root(argv[2],argv[3],argv[4]);if(!safe_name(argv[5]))die("unsafe_stage_identity");if(mkdirat(root,argv[5],0700)&&errno!=EEXIST)die("stage_mkdir_failed");if(fsync(root))die("stage_directory_fsync_failed");close(root);}
static void stage_file(int argc,char **argv){if(argc!=9)die("stage_file_arity");int root=artifact_root(argv[2],argv[3],argv[4]);if(!safe_name(argv[5]))die("unsafe_stage_identity");if(mkdirat(root,argv[5],0700)&&errno!=EEXIST)die("stage_mkdir_failed");int work=open_beneath(root,argv[5],O_RDONLY|O_DIRECTORY,0);if(work<0)die("stage_open_failed");char *leaf=NULL;int parent=walk_parent(work,argv[6],1,&leaf);int file=open_beneath(parent,leaf,O_WRONLY|O_CREAT|O_EXCL,0400);if(file<0&&errno==EEXIST){file=open_beneath(parent,leaf,O_RDONLY,0);if(file<0)die("existing_stage_refused");char digest[65];struct stat st;if(fstat(file,&st)||!S_ISREG(st.st_mode)||st.st_nlink!=1)die("existing_stage_refused");hash_fd(file,digest);if(strcmp(digest,argv[7])||st.st_size!=number(argv[8]))die("stage_conflict");}else if(file<0)die("stage_create_failed");else{int input=fcntl(3,F_GETFD)>=0?3:STDIN_FILENO;Sha256 hash;sha_init(&hash);unsigned char buffer[65536];ssize_t n;off_t size=0;while((n=read(input,buffer,sizeof buffer))>0){sha_add(&hash,buffer,(size_t)n);size+=n;for(ssize_t off=0;off<n;){ssize_t wrote=write(file,buffer+off,(size_t)(n-off));if(wrote<0)die("stage_write_failed");off+=wrote;}}if(n<0)die("stage_input_failed");char digest[65];sha_done(&hash,digest);if(strcmp(digest,argv[7])||size!=number(argv[8]))die("stage_digest_mismatch");if(fsync(file))die("stage_file_fsync_failed");}close(file);if(fsync(parent)||fsync(work)||fsync(root))die("stage_directory_fsync_failed");free(leaf);close(parent);close(work);close(root);}
static void commit_stage(int argc,char **argv){if(argc!=7)die("commit_arity");int root=artifact_root(argv[2],argv[3],argv[4]);if(!safe_name(argv[5])||!safe_name(argv[6]))die("unsafe_stage_identity");if(syscall(SYS_renameat2,root,argv[5],root,argv[6],RENAME_NOREPLACE)){if(errno==EEXIST)exit(17);die("stage_rename_failed");}if(fsync(root))die("stage_commit_fsync_failed");close(root);}
static void verify_file(int argc,char **argv){if(argc!=9)die("verify_arity");int root=artifact_root(argv[2],argv[3],argv[4]);if(!safe_name(argv[5]))die("unsafe_stage_identity");int identity=open_beneath(root,argv[5],O_RDONLY|O_DIRECTORY,0);if(identity<0)die("identity_open_refused");char *leaf=NULL;int parent=walk_parent(identity,argv[6],0,&leaf);int file=open_beneath(parent,leaf,O_RDONLY,0);struct stat st;if(file<0||fstat(file,&st)||!S_ISREG(st.st_mode)||st.st_nlink!=1||st.st_size!=number(argv[8]))die("verification_metadata_mismatch");char digest[65];hash_fd(file,digest);if(strcmp(digest,argv[7]))die("verification_digest_mismatch");free(leaf);close(file);close(parent);close(identity);close(root);}
static void verify_stage(int argc,char **argv){if(argc!=6)die("verify_stage_arity");int root=artifact_root(argv[2],argv[3],argv[4]);if(!safe_name(argv[5]))die("unsafe_stage_identity");int identity=open_beneath(root,argv[5],O_RDONLY|O_DIRECTORY,0);if(identity<0)die("identity_open_refused");close(identity);close(root);}
#endif

#if defined(WF_RESULT_SEALER_ONLY) == defined(WF_ARTIFACT_STORE_ONLY)
#error "select exactly one native descriptor boundary"
#endif
int main(int argc,char **argv){if(argc<2)die("missing_command");if(!strcmp(argv[1],"probe")){struct open_how h={.flags=O_PATH,.resolve=RESOLVE_BENEATH};int fd=(int)syscall(SYS_openat2,AT_FDCWD,".",&h,sizeof h);if(fd<0)die("openat2_unavailable");close(fd);
#ifdef WF_RESULT_SEALER_ONLY
puts("linux-descriptor-sealer-v1");
#else
puts("linux-descriptor-artifact-store-v1");
#endif
return 0;}
#ifdef WF_RESULT_SEALER_ONLY
if(!strcmp(argv[1],"scan"))scan_command(argc,argv);else if(!strcmp(argv[1],"seal"))seal_command(argc,argv);else die("unknown_command");
#else
if(!strcmp(argv[1],"prepare-stage"))prepare_stage(argc,argv);else if(!strcmp(argv[1],"stage-file"))stage_file(argc,argv);else if(!strcmp(argv[1],"commit-stage"))commit_stage(argc,argv);else if(!strcmp(argv[1],"verify-file"))verify_file(argc,argv);else if(!strcmp(argv[1],"verify-stage"))verify_stage(argc,argv);else die("unknown_command");
#endif
return 0;}
