import { BlobClient, BlockBlobClient, newPipeline } from "@azure/storage-blob";

export const AZURITE_API_VERSION = "2025-11-05";

function apiVersionPolicy() {
  return {
    create(nextPolicy) {
      return {
        sendRequest(request) {
          request.headers.set("x-ms-version", AZURITE_API_VERSION);
          return nextPolicy.sendRequest(request);
        },
      };
    },
  };
}

export function azuritePipeline(credential) {
  const pipeline = newPipeline(credential);
  pipeline.factories.push(apiVersionPolicy());
  return pipeline;
}

export function azuriteBlobClient(blobUrl) {
  return new BlobClient(blobUrl, azuritePipeline());
}

export function azuriteBlockBlobClient(blobUrl) {
  return new BlockBlobClient(blobUrl, azuritePipeline());
}

export const azuriteUploadSdk = Object.freeze({
  async upload(input) {
    const response = await azuriteBlockBlobClient(input.blobUrl).upload(
      input.bytes,
      input.bytes.byteLength,
      {
        abortSignal: input.abortSignal,
        blobHTTPHeaders: { blobContentMD5: input.contentMd5 },
        conditions: { ifNoneMatch: "*" },
        metadata: { wfsha256: input.sha256 },
      },
    );
    return Object.freeze({
      ...(response.contentMD5 === undefined
        ? {}
        : { contentMd5: response.contentMD5 }),
    });
  },
});

export const azuriteMetadataSdk = Object.freeze({
  async properties(input) {
    const properties = await azuriteBlobClient(input.blobUrl).getProperties({
      abortSignal: input.abortSignal,
    });
    return Object.freeze({
      ...(properties.blobType === undefined
        ? {}
        : { blobType: properties.blobType }),
      ...(properties.contentMD5 === undefined
        ? {}
        : { contentMd5: properties.contentMD5 }),
      ...(properties.contentLength === undefined
        ? {}
        : { contentLength: properties.contentLength }),
      ...(properties.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...properties.metadata }) }),
    });
  },
});

export const azuriteRetentionSdk = Object.freeze({
  async delete(input) {
    await azuriteBlobClient(input.blobUrl).delete({
      abortSignal: input.abortSignal,
      conditions: { ifMatch: input.etag },
    });
  },
  async properties(input) {
    const properties = await azuriteBlobClient(input.blobUrl).getProperties({
      abortSignal: input.abortSignal,
    });
    return Object.freeze({
      ...(properties.contentLength === undefined
        ? {}
        : { contentLength: properties.contentLength }),
      ...(properties.etag === undefined ? {} : { etag: properties.etag }),
      ...(properties.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...properties.metadata }) }),
    });
  },
});
