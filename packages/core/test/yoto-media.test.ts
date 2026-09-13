import { describe, expect, it } from "vitest";
import { isYotoError } from "../src/errors.js";
import { YotoClient } from "../src/yoto/client.js";
import { uploadAudio } from "../src/yoto/media.js";
import { makeFakeFetch } from "./helpers/fake-fetch.js";

function makeAudioSource(): {
  stream: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  filename: string;
} {
  const bytes = new TextEncoder().encode("fake mp3 bytes");
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.length,
    contentType: "audio/mpeg",
    filename: "lullaby.mp3",
  };
}

describe("uploadAudio", () => {
  it("gets an upload URL, PUTs the bytes, polls until transcodedSha256 appears, and returns a mediaRef", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      // 1. GET /media/transcode/audio/uploadUrl
      {
        status: 200,
        jsonBody: { upload: { uploadId: "upload-1", uploadUrl: "https://s3.example/upload-1" } },
      },
      // 2. PUT to the signed URL
      { status: 200 },
      // 3-5. poll x3 -- not ready, not ready, ready
      { status: 200, jsonBody: { transcode: {} } },
      { status: 200, jsonBody: { transcode: {} } },
      {
        status: 200,
        jsonBody: {
          transcode: {
            transcodedSha256: "abc123sha",
            transcodedInfo: { duration: 42, fileSize: 1024, channels: "mono", format: "aac" },
          },
        },
      },
    ]);
    const client = new YotoClient({ getToken: async () => "token", fetchImpl: fakeFetch });
    const result = await uploadAudio(client, makeAudioSource(), {
      pollIntervalMs: 0,
      sleep: async () => {},
    });

    expect(result.mediaRef).toBe("yoto:#abc123sha");
    expect(result.transcodedInfo).toEqual({
      duration: 42,
      fileSize: 1024,
      channels: "mono",
      format: "aac",
    });
    expect(calls).toHaveLength(5);
    expect(calls[1]?.url).toBe("https://s3.example/upload-1");
    expect(calls[1]?.method).toBe("PUT");
  });

  it("skips the PUT when Yoto already has a matching file (uploadUrl: null, dedup)", async () => {
    const { fetch: fakeFetch, calls } = makeFakeFetch([
      { status: 200, jsonBody: { upload: { uploadId: "upload-2", uploadUrl: null } } },
      {
        status: 200,
        jsonBody: { transcode: { transcodedSha256: "dedup-sha", transcodedInfo: {} } },
      },
    ]);
    const client = new YotoClient({ getToken: async () => "token", fetchImpl: fakeFetch });
    const result = await uploadAudio(client, makeAudioSource(), { sleep: async () => {} });
    expect(result.mediaRef).toBe("yoto:#dedup-sha");
    expect(calls).toHaveLength(2); // uploadUrl + one poll -- no PUT call
  });

  it("throws TRANSCODE_TIMEOUT if the deadline passes before transcodedSha256 appears", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([
      { status: 200, jsonBody: { upload: { uploadId: "upload-3", uploadUrl: null } } },
      { status: 200, jsonBody: { transcode: {} } },
      { status: 200, jsonBody: { transcode: {} } },
    ]);
    const client = new YotoClient({ getToken: async () => "token", fetchImpl: fakeFetch });
    let now = 0;
    try {
      await uploadAudio(client, makeAudioSource(), {
        pollIntervalMs: 10,
        timeoutMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isYotoError(error)).toBe(true);
      if (isYotoError(error)) expect(error.code).toBe("TRANSCODE_TIMEOUT");
    }
  });
});
