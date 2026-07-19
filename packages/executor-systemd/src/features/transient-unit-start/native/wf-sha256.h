#ifndef WF_SHA256_H
#define WF_SHA256_H

#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  uint32_t h[8];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
} WfSha256;

static const uint32_t WF_SHA_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static uint32_t wf_sha_rotate_right(uint32_t value, unsigned int bits) {
  return (value >> bits) | (value << (32U - bits));
}

static void wf_sha_block(WfSha256 *state, const unsigned char *input) {
  uint32_t words[64], a, b, c, d, e, f, g, h;
  for (size_t index = 0; index < 16; index++) {
    size_t offset = index * 4;
    words[index] = ((uint32_t)input[offset] << 24) |
                   ((uint32_t)input[offset + 1] << 16) |
                   ((uint32_t)input[offset + 2] << 8) | input[offset + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    uint32_t left = words[index - 15], right = words[index - 2];
    words[index] =
        (wf_sha_rotate_right(right, 17) ^ wf_sha_rotate_right(right, 19) ^
         (right >> 10)) +
        words[index - 7] +
        (wf_sha_rotate_right(left, 7) ^ wf_sha_rotate_right(left, 18) ^
         (left >> 3)) +
        words[index - 16];
  }
  a = state->h[0];
  b = state->h[1];
  c = state->h[2];
  d = state->h[3];
  e = state->h[4];
  f = state->h[5];
  g = state->h[6];
  h = state->h[7];
  for (size_t index = 0; index < 64; index++) {
    uint32_t first =
        h + (wf_sha_rotate_right(e, 6) ^ wf_sha_rotate_right(e, 11) ^
             wf_sha_rotate_right(e, 25)) +
        ((e & f) ^ ((~e) & g)) + WF_SHA_K[index] + words[index];
    uint32_t second =
        (wf_sha_rotate_right(a, 2) ^ wf_sha_rotate_right(a, 13) ^
         wf_sha_rotate_right(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c));
    h = g;
    g = f;
    f = e;
    e = d + first;
    d = c;
    c = b;
    b = a;
    a = first + second;
  }
  state->h[0] += a;
  state->h[1] += b;
  state->h[2] += c;
  state->h[3] += d;
  state->h[4] += e;
  state->h[5] += f;
  state->h[6] += g;
  state->h[7] += h;
}

static void wf_sha_init(WfSha256 *state) {
  const uint32_t initial[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372,
                               0xa54ff53a, 0x510e527f, 0x9b05688c,
                               0x1f83d9ab, 0x5be0cd19};
  memcpy(state->h, initial, sizeof(initial));
  state->bits = 0;
  state->used = 0;
}

static void wf_sha_add(WfSha256 *state, const void *data, size_t length) {
  const unsigned char *cursor = data;
  state->bits += (uint64_t)length * 8;
  while (length > 0) {
    size_t take = 64 - state->used;
    if (take > length)
      take = length;
    memcpy(state->block + state->used, cursor, take);
    state->used += take;
    cursor += take;
    length -= take;
    if (state->used == 64) {
      wf_sha_block(state, state->block);
      state->used = 0;
    }
  }
}

static void wf_sha_done(WfSha256 *state, char output[65]) {
  uint64_t bits = state->bits;
  state->block[state->used++] = 0x80;
  if (state->used > 56) {
    while (state->used < 64)
      state->block[state->used++] = 0;
    wf_sha_block(state, state->block);
    state->used = 0;
  }
  while (state->used < 56)
    state->block[state->used++] = 0;
  for (int index = 7; index >= 0; index--)
    state->block[state->used++] = (unsigned char)(bits >> (index * 8));
  wf_sha_block(state, state->block);
  for (size_t index = 0; index < 8; index++)
    snprintf(output + index * 8, 9, "%08x", state->h[index]);
  output[64] = '\0';
}

static void wf_sha256(const char *value, size_t length, char output[65]) {
  WfSha256 state;
  wf_sha_init(&state);
  wf_sha_add(&state, value, length);
  wf_sha_done(&state, output);
}

#endif
