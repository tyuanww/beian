import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, describe, it, mock } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-probe-timeout-");

const { saveSettings, runProbe } = await import("./settings.js");

describe("feishu probe timeout", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // Value: protects=a timed-out Feishu token request sets code timeout; fails_when=destroy drops the timeout tag; why_new=credentials test never opens a socket; seam=none; no_claim=does not reach Feishu
  it("reports timeout when the token request times out", async () => {
    saveSettings({ FEISHU_APP_ID: "cli_probe", FEISHU_APP_SECRET: "secret-probe" });
    mock.method(https, "request", () => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: string) => boolean;
        end: () => void;
        destroy: (err?: Error) => void;
      };
      req.write = () => true;
      req.destroy = (err) => {
        if (err) req.emit("error", err);
      };
      req.end = () => {
        req.emit("timeout");
      };
      return req;
    });
    const result = await runProbe("feishu");
    assert.equal(result.ok, false);
    assert.equal(result.code, "timeout");
    assert.match(result.message, /超时/);
  });
});
