const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractVideoFrame, reserveVideoFrame } = require("../../src/util/util/VideoFrame.ts");

test("video previews coalesce, reject excess work and bound child output", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-video-bounds-"));
    const executable = path.join(directory, "ffmpeg");
    const counter = path.join(directory, "counter");
    const previous = process.env.FFMPEG_PATH;
    fs.writeFileSync(
        executable,
        `#!${process.execPath}
const fs=require("node:fs"); fs.appendFileSync(${JSON.stringify(counter)}, "x"); const input=fs.readFileSync(process.argv[process.argv.indexOf("-i")+1], "utf8"); setTimeout(()=>{process.stdout.write(Buffer.alloc(input==="oversize"?5*1024*1024:16));}, 120);`,
    );
    fs.chmodSync(executable, 0o700);
    process.env.FFMPEG_PATH = executable;
    try {
        const first = extractVideoFrame(Buffer.from("same"));
        const same = Array.from({ length: 12 }, () => extractVideoFrame(Buffer.from("same")));
        const other = ["two", "three", "four"].map((value) => extractVideoFrame(Buffer.from(value)));
        assert.equal(await extractVideoFrame(Buffer.from("five")), null);
        const frames = await Promise.all([first, ...same, ...other]);
        assert.equal(fs.readFileSync(counter, "utf8").length, 4);
        assert.ok(frames.every((frame) => frame?.length === 16));
        assert.equal(await extractVideoFrame(Buffer.from("oversize")), null);
        assert.equal((await extractVideoFrame(Buffer.from("after")))?.length, 16);
        assert.equal(await extractVideoFrame(Buffer.alloc(64 * 1024 * 1024 + 1)), null);
        assert.equal(await extractVideoFrame(Buffer.from("timeout"), 1), null);
    } finally {
        if (previous === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("a preview slot is reserved before the video is downloaded and counts against the job cap", async () => {
    const reservations = Array.from({ length: 4 }, () => reserveVideoFrame());
    assert.ok(reservations.every(Boolean));
    assert.equal(reserveVideoFrame(), null);
    assert.equal(await extractVideoFrame(Buffer.from("unreserved")), null);
    reservations[0]();
    reservations[0]();
    const next = reserveVideoFrame();
    assert.ok(next);
    assert.equal(reserveVideoFrame(), null);
    next();
    for (const release of reservations.slice(1)) release();
    const all = Array.from({ length: 4 }, () => reserveVideoFrame());
    assert.ok(all.every(Boolean));
    for (const release of all) release();
});

test("callers route every preview through a reservation taken before the download", () => {
    const proxy = fs.readFileSync(path.join(__dirname, "../../src/api/middlewares/ExternalProxy.ts"), "utf8");
    assert.ok(proxy.indexOf("reserveVideoFrame()") < proxy.indexOf("maxBytes: MAX_SIZE, timeoutMs: 15000, firstByteMs: 5000 })\n"));
    const cdn = fs.readFileSync(path.join(__dirname, "../../src/cdn/routes/attachments.ts"), "utf8");
    assert.ok(cdn.indexOf("reserveVideoFrame()") < cdn.indexOf("for await (const chunk of inspected.stream)"));
    assert.match(cdn, /extractVideoFrame\([^)]*\), undefined, true\)/);
});

test("real ffmpeg preserves valid video preview extraction", async (context) => {
    const binary = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
    if (!binary) return context.skip("ffmpeg is not installed");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-video-real-"));
    const file = path.join(directory, "sample.mp4");
    try {
        const generated = spawnSync(binary, ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=0.1", "-c:v", "mpeg4", file]);
        assert.equal(generated.status, 0);
        const frame = await extractVideoFrame(fs.readFileSync(file));
        assert.ok(frame?.length > 0);
        assert.equal(frame.readUInt16BE(0), 0xffd8);
        assert.equal(await extractVideoFrame(Buffer.from(`ffconcat version 1.0\nfile '${file}'\n`)), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
