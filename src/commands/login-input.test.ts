import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  InputTooLongError,
  type ReadableLike,
  readFirstLine,
  readSecret,
  StdinClosedError,
  type TtyStdin,
} from "./login-input";

class FakeTty extends EventEmitter {
  readonly rawModes: boolean[] = [];

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
}

function asTty(tty: FakeTty): TtyStdin {
  return tty;
}

describe("readSecret (real hidden reader)", () => {
  test("writes only the prompt and a newline — never the typed characters", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.from("mar_live_"));
    tty.emit("data", Buffer.from("SECRET"));
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("mar_live_SECRET");
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("takes raw mode BEFORE writing the prompt", async () => {
    const order: string[] = [];
    class OrderedTty extends EventEmitter {
      readonly rawModes: boolean[] = [];

      setRawMode(mode: boolean): void {
        this.rawModes.push(mode);
        order.push(`raw:${mode}`);
      }
    }
    const tty = new OrderedTty();
    const secret = readSecret(
      tty as unknown as TtyStdin,
      (text) => order.push(`write:${JSON.stringify(text)}`),
      "P: ",
    );
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("");
    expect(order.slice(0, 2)).toEqual(["raw:true", 'write:"P: "']);
  });

  test("Ctrl-C resolves undefined and restores the terminal", async () => {
    const tty = new FakeTty();
    const writes: string[] = [];
    const secret = readSecret(asTty(tty), (text) => writes.push(text), "Router key: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x03])]));
    await expect(secret).resolves.toBeUndefined();
    expect(writes).toEqual(["Router key: ", "\n"]);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("Ctrl-U clears the line so far", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.concat([Buffer.from("abc"), Buffer.from([0x15]), Buffer.from("xy\r")]));
    await expect(secret).resolves.toBe("xy");
  });

  test("other control bytes are ignored, not recorded", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    // 0x01 (Ctrl-A), 0x02, 0x1b (ESC), 0x00 — dropped; letters kept.
    tty.emit("data", Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from("a")]));
    tty.emit("data", Buffer.concat([Buffer.from([0x1b, 0x00]), Buffer.from("b\r")]));
    await expect(secret).resolves.toBe("ab");
  });

  test("backspace and DEL remove the last code point", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit(
      "data",
      Buffer.concat([Buffer.from("abcd"), Buffer.from([0x08]), Buffer.from([0x7f])]),
    );
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe("ab");
  });

  test("decodes a code point split across chunks (utf-8 stream mode)", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from([0xc3])); // first byte of é
    tty.emit("data", Buffer.concat([Buffer.from([0xa9]), Buffer.from("\r")]));
    await expect(secret).resolves.toBe("é");
  });

  test("stream end restores raw mode and rejects with StdinClosedError", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from("partial"));
    tty.emit("end");
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("stream error restores raw mode and rejects with StdinClosedError", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("error", new Error("EIO"));
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("SIGHUP restores raw mode and rejects with StdinClosedError too", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    process.kill(process.pid, "SIGHUP");
    await expect(secret).rejects.toBeInstanceOf(StdinClosedError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("typing past 4096 bytes rejects with InputTooLongError and restores the tty", async () => {
    const tty = new FakeTty();
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from("a".repeat(4097)));
    await expect(secret).rejects.toBeInstanceOf(InputTooLongError);
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("exactly 4096 bytes is still accepted", async () => {
    const tty = new FakeTty();
    const line = "a".repeat(4096);
    const secret = readSecret(asTty(tty), () => {}, "P: ");
    tty.emit("data", Buffer.from(line));
    tty.emit("data", Buffer.from("\r"));
    await expect(secret).resolves.toBe(line);
  });
});

class FakeReadable extends EventEmitter {}

function asReadable(stream: FakeReadable): ReadableLike {
  return stream;
}

describe("readFirstLine (real stdin reader)", () => {
  test("stops at the first newline, even mid-chunk", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("mar_live_X\nrest is ignored"));
    await expect(line).resolves.toBe("mar_live_X");
  });

  test("finds a newline that arrives in a later chunk (no whole-buffer rescans)", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("first-chunk-no-newline"));
    stream.emit("data", Buffer.from(" then\nrest is ignored"));
    await expect(line).resolves.toBe("first-chunk-no-newline then");
  });

  test("resolves the whole buffer at EOF when there is no newline", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", "mar_live_NOEOF");
    stream.emit("end");
    await expect(line).resolves.toBe("mar_live_NOEOF");
  });

  test("accepts exactly 4096 bytes without a newline", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("a".repeat(4096)));
    stream.emit("end");
    await expect(line).resolves.toBe("a".repeat(4096));
  });

  test("rejects with InputTooLongError the moment the total passes 4096 bytes", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from("a".repeat(4096)));
    stream.emit("data", Buffer.from("b"));
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
  });

  test("a 1 MiB no-newline stream is refused at once, not buffered", async () => {
    const stream = new FakeReadable();
    const started = Date.now();
    const line = readFirstLine(asReadable(stream));
    // One chunk per 64 KiB, like a real pipe; the cap trips on the first one.
    const chunk = Buffer.from("a".repeat(64 * 1024));
    for (let i = 0; i < 16; i++) {
      stream.emit("data", chunk);
    }
    stream.emit("end");
    await expect(line).rejects.toBeInstanceOf(InputTooLongError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("decodes a code point split across chunks", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("data", Buffer.from([0xf0, 0x9f])); // first half of an emoji
    stream.emit("data", Buffer.from([0x98, 0x80]));
    stream.emit("end");
    await expect(line).resolves.toBe("😀");
  });

  test("rejects on a stream error so the caller can exit cleanly", async () => {
    const stream = new FakeReadable();
    const line = readFirstLine(asReadable(stream));
    stream.emit("error", new Error("EPIPE"));
    await expect(line).rejects.toThrow("EPIPE");
  });
});
