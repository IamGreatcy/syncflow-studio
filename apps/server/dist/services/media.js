import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export async function checkFfmpegAvailability() {
    let ffmpegVer = null;
    let ffprobeVer = null;
    try {
        const { stdout } = await execFileAsync('ffmpeg', ['-version'], {
            timeout: 5000,
        });
        ffmpegVer = stdout.split(/\r?\n/)[0]?.trim() || 'available';
    }
    catch {
        ffmpegVer = null;
    }
    try {
        const { stdout } = await execFileAsync('ffprobe', ['-version'], {
            timeout: 5000,
        });
        ffprobeVer = stdout.split(/\r?\n/)[0]?.trim() || 'available';
    }
    catch {
        ffprobeVer = null;
    }
    return { ffmpeg: ffmpegVer, ffprobe: ffprobeVer };
}
/**
 * Reads top-level ISO BMFF (MP4/MOV) boxes to verify whether `moov` appears before `mdat`
 * (required for reliable faststart streaming on Instagram/Facebook).
 */
export async function detectFaststartMoov(filePath) {
    let handle = null;
    try {
        const stat = await fs.promises.stat(filePath);
        handle = await fs.promises.open(filePath, 'r');
        const header = Buffer.alloc(16);
        let offset = 0;
        let firstBoxChecked = false;
        let seenMoov = false;
        let seenMdat = false;
        for (let iter = 0; iter < 64 && offset + 8 <= stat.size; iter++) {
            const { bytesRead } = await handle.read(header, 0, 16, offset);
            if (bytesRead < 8)
                break;
            const size32 = header.readUInt32BE(0);
            const boxType = header.toString('ascii', 4, 8);
            if (!firstBoxChecked) {
                firstBoxChecked = true;
                // Not an ISO BMFF container (e.g. WebM/MKV)
                if (boxType !== 'ftyp' && boxType !== 'free' && boxType !== 'wide') {
                    return null;
                }
            }
            if (boxType === 'moov') {
                seenMoov = true;
                if (!seenMdat)
                    return true;
            }
            else if (boxType === 'mdat') {
                seenMdat = true;
                if (!seenMoov)
                    return false;
            }
            let boxSize = BigInt(size32);
            if (size32 === 1 && bytesRead >= 16) {
                boxSize = header.readBigUInt64BE(8);
            }
            else if (size32 === 0) {
                break;
            }
            if (boxSize < 8n)
                break;
            const nextOffset = Number(BigInt(offset) + boxSize);
            if (!Number.isFinite(nextOffset) || nextOffset <= offset)
                break;
            offset = nextOffset;
        }
        if (seenMoov && !seenMdat)
            return true;
        return null;
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
function parseFrameRate(raw) {
    if (typeof raw !== 'string' || !raw.includes('/')) {
        const num = Number(raw);
        return Number.isFinite(num) && num > 0 ? num : 30;
    }
    const [nStr, dStr] = raw.split('/');
    const n = Number(nStr);
    const d = Number(dStr);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0)
        return 30;
    return Math.round((n / d) * 100) / 100;
}
export async function probeVideo(filePath) {
    const stat = await fs.promises.stat(filePath);
    const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
    ], { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const streams = parsed.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    if (!videoStream) {
        throw new Error('ไม่พบ Video Stream ในไฟล์ที่อัปโหลด');
    }
    let rotation = 0;
    if (videoStream.tags?.rotate) {
        rotation = Number(videoStream.tags.rotate) || 0;
    }
    else if (Array.isArray(videoStream.side_data_list)) {
        const rotEntry = videoStream.side_data_list.find((d) => typeof d.rotation === 'number');
        if (rotEntry && typeof rotEntry.rotation === 'number') {
            rotation = rotEntry.rotation;
        }
    }
    const durationSec = Math.max(0, Math.round((Number(parsed.format?.duration ?? 0) || 0) * 100) / 100);
    const bitrateKbps = Math.round((Number(parsed.format?.bit_rate ?? 0) || 0) / 1000);
    const hasFaststartMoov = await detectFaststartMoov(filePath);
    return {
        durationSec,
        width: Number(videoStream.width ?? 0),
        height: Number(videoStream.height ?? 0),
        rotation,
        fps: parseFrameRate(videoStream.avg_frame_rate !== '0/0'
            ? videoStream.avg_frame_rate
            : videoStream.r_frame_rate),
        videoCodec: String(videoStream.codec_name ?? 'unknown'),
        audioCodec: audioStream ? String(audioStream.codec_name ?? 'unknown') : null,
        audioSampleRate: audioStream?.sample_rate
            ? Number(audioStream.sample_rate)
            : null,
        bitrateKbps,
        fileSizeBytes: stat.size,
        hasFaststartMoov,
    };
}
export async function extractThumbnails(filePath, thumbDir, durationSec) {
    fs.mkdirSync(thumbDir, { recursive: true });
    const fractions = [0.05, 0.25, 0.5, 0.75];
    const created = [];
    for (let i = 0; i < fractions.length; i++) {
        const seekSec = Math.max(0, Math.min(Math.max(0, durationSec - 0.2), durationSec * fractions[i]));
        const outFile = path.join(thumbDir, `thumb_${i}.jpg`);
        try {
            await execFileAsync('ffmpeg', [
                '-y',
                '-ss',
                seekSec.toFixed(2),
                '-i',
                filePath,
                '-frames:v',
                '1',
                '-q:v',
                '3',
                outFile,
            ], { timeout: 20_000 });
            if (fs.existsSync(outFile)) {
                created.push(`thumb_${i}.jpg`);
            }
        }
        catch {
            // Continue trying remaining timestamps if one keyframe fails
        }
    }
    return created;
}
export async function optimizeVideoForPlatforms(inputPath, outputPath, probe) {
    const codecOk = probe.videoCodec.toLowerCase() === 'h264';
    const audioOk = !probe.audioCodec || probe.audioCodec.toLowerCase() === 'aac';
    const widthOk = probe.width <= 1920;
    const fpsOk = probe.fps <= 60;
    const bitrateOk = probe.bitrateKbps <= 24_000;
    const sizeOk = probe.fileSizeBytes <= 290 * 1024 * 1024;
    if (codecOk && audioOk && widthOk && fpsOk && bitrateOk && sizeOk) {
        await execFileAsync('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-c',
            'copy',
            '-map_metadata',
            '-1',
            '-metadata:s:v:0',
            'handler_name=VideoHandler',
            '-metadata:s:a:0',
            'handler_name=SoundHandler',
            '-movflags',
            '+faststart',
            outputPath,
        ], { timeout: 120_000 });
        const newProbe = await probeVideo(outputPath);
        return {
            action: 'REMUX_FASTSTART',
            outputPath,
            probe: newProbe,
        };
    }
    await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-map_metadata',
        '-1',
        '-metadata:s:v:0',
        'handler_name=VideoHandler',
        '-metadata:s:a:0',
        'handler_name=SoundHandler',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-crf',
        '21',
        '-vf',
        "scale='min(1920,iw)':-2",
        '-r',
        '30',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath,
    ], { timeout: 600_000 });
    const newProbe = await probeVideo(outputPath);
    return {
        action: 'TRANSCODE_H264_AAC',
        outputPath,
        probe: newProbe,
    };
}
export async function normalizeCoverImage(inputPath, outputJpegPath) {
    fs.mkdirSync(path.dirname(outputJpegPath), { recursive: true });
    await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(1920,iw)':-2",
        '-q:v',
        '3',
        outputJpegPath,
    ], { timeout: 20_000 });
    let stat = await fs.promises.stat(outputJpegPath);
    if (stat.size > 1_800_000) {
        await execFileAsync('ffmpeg', [
            '-y',
            '-i',
            inputPath,
            '-frames:v',
            '1',
            '-vf',
            "scale='min(1280,iw)':-2",
            '-q:v',
            '7',
            outputJpegPath,
        ], { timeout: 20_000 });
        stat = await fs.promises.stat(outputJpegPath);
    }
    return { outputPath: outputJpegPath, sizeBytes: stat.size };
}
export async function prependCoverFrameToVideo(params) {
    const { videoPath, coverImagePath, outputPath, probe, coverDurationSec = 0.15, } = params;
    const rot = ((probe.rotation % 360) + 360) % 360;
    const rawW = rot === 90 || rot === 270 ? probe.height : probe.width;
    const rawH = rot === 90 || rot === 270 ? probe.width : probe.height;
    const w = rawW > 0 ? Math.max(2, Math.floor(rawW / 2) * 2) : 720;
    const h = rawH > 0 ? Math.max(2, Math.floor(rawH / 2) * 2) : 1280;
    const fps = probe.fps > 0 && probe.fps <= 60 ? probe.fps : 30;
    const sampleRate = probe.audioSampleRate && probe.audioSampleRate > 0
        ? probe.audioSampleRate
        : 48000;
    const hasAudio = Boolean(probe.audioCodec);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;
    const filterComplex = hasAudio
        ? `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p[covv];` +
            `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[mainv];` +
            `[2:a]aformat=sample_rates=${sampleRate}:channel_layouts=stereo[cova];` +
            `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=stereo[maina];` +
            `[covv][cova][mainv][maina]concat=n=2:v=1:a=1[v][a]`
        : `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps},format=yuv420p[covv];` +
            `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[mainv];` +
            `[covv][mainv]concat=n=2:v=1:a=0[v]`;
    const args = [
        '-y',
        '-loop',
        '1',
        '-t',
        String(coverDurationSec),
        '-i',
        coverImagePath,
        '-i',
        videoPath,
        ...(hasAudio
            ? [
                '-f',
                'lavfi',
                '-t',
                String(coverDurationSec),
                '-i',
                `anullsrc=r=${sampleRate}:cl=stereo`,
            ]
            : []),
        '-filter_complex',
        filterComplex,
        '-map',
        '[v]',
        ...(hasAudio ? ['-map', '[a]'] : []),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-g',
        String(Math.max(12, Math.round(fps * 2))),
        ...(hasAudio ? ['-c:a', 'aac', '-ar', String(sampleRate), '-b:a', '128k'] : []),
        '-map_metadata',
        '-1',
        '-metadata:s:v:0',
        'handler_name=VideoHandler',
        ...(hasAudio ? ['-metadata:s:a:0', 'handler_name=SoundHandler'] : []),
        '-movflags',
        '+faststart',
        tmpPath,
    ];
    try {
        await execFileAsync('ffmpeg', args, { timeout: 600_000 });
        fs.renameSync(tmpPath, outputPath);
        const stat = await fs.promises.stat(outputPath);
        return { outputPath, sizeBytes: stat.size };
    }
    catch (err) {
        fs.rmSync(tmpPath, { force: true });
        throw err;
    }
}
//# sourceMappingURL=media.js.map