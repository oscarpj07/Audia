import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export async function stitchAudio(segments, outputPath, tempDir) {
  if (segments.length === 0) {
    throw new Error('No audio segments to stitch');
  }

  // FFmpeg concat list — absolute paths required with safe=0
  const concatListPath = path.join(tempDir, 'concat.txt');
  const concatContent = segments.map(s => `file '${s}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent);

  try {
    execSync(
      `ffmpeg -f concat -safe 0 -i "${concatListPath}" -acodec libmp3lame -q:a 4 "${outputPath}" -y`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    throw new Error(`FFmpeg failed: ${stderr.slice(0, 500)}`);
  }

  // Clean up individual segment files and concat list
  for (const seg of segments) {
    try { fs.unlinkSync(seg); } catch {}
  }
  try { fs.unlinkSync(concatListPath); } catch {}
}
