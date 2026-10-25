import { beforeEach, describe, expect, it } from "vitest";

import { nextMessageId, resetMessageIds } from "./id";

describe("nextMessageId", () => {
  beforeEach(() => {
    resetMessageIds();
  });

  it("increments per call", () => {
    expect(nextMessageId("send")).toBe("send-1");
    expect(nextMessageId("send")).toBe("send-2");
  });

  it("keeps separate prefixes on one counter", () => {
    nextMessageId("install");
    expect(nextMessageId("ack")).toBe("ack-2");
  });

  it("defaults the prefix to msg", () => {
    expect(nextMessageId()).toBe("msg-1");
  });

  it("restarts from 1 after resetMessageIds()", () => {
    nextMessageId();
    nextMessageId();
    resetMessageIds();
    expect(nextMessageId()).toBe("msg-1");
  });
});
