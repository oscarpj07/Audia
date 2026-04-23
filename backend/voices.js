import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function getVoiceIds() {
  return [
    process.env.ELEVENLABS_VOICE_1,
    process.env.ELEVENLABS_VOICE_2
  ];
}

function parseScriptLines(script, speakerMap) {
  const lines = script.split('\n');
  const parsed = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let matched = false;
    for (const [speaker, idx] of Object.entries(speakerMap)) {
      const prefix = `${speaker}:`;
      if (trimmed.startsWith(prefix)) {
        const text = trimmed.slice(prefix.length).trim();
        if (text) {
          parsed.push({ speakerIndex: idx, text });
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      console.warn(`[voices] Skipping unmatched line: "${trimmed.slice(0, 60)}"`);
    }
  }

  return parsed;
}

// TEST_MODE: generate silent audio via FFmpeg instead of calling ElevenLabs.
// Duration is proportional to text length (~130 words/min speaking pace).
function generateSilentSegment(text, segmentPath) {
  const words = text.split(/\s+/).length;
  const duration = Math.max(1, Math.round((words / 130) * 60));
  execSync(
    `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${duration} -q:a 9 -acodec libmp3lame "${segmentPath}" -y`,
    { stdio: 'pipe' }
  );
}

async function ttsRequest(text, voiceId, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        data: {
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.80,
            style: 0.2,
            use_speaker_boost: true
          }
        },
        responseType: 'arraybuffer',
        timeout: 30000
      });
      return response.data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

export async function generateAudioSegments(script, speakerMap, tempDir, onProgress) {
  const testMode = process.env.TEST_MODE === 'true';
  if (testMode) {
    console.log('[voices] TEST_MODE enabled — using silent audio, no ElevenLabs calls');
  }

  const lines = parseScriptLines(script, speakerMap);
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const { speakerIndex, text } = lines[i];
    const segmentPath = path.join(tempDir, `seg_${String(i).padStart(5, '0')}.mp3`);

    if (testMode) {
      generateSilentSegment(text, segmentPath);
    } else {
      const voiceId = getVoiceIds()[speakerIndex];
      if (!voiceId) throw new Error(`ELEVENLABS_VOICE_${speakerIndex + 1} is not set in .env`);
      const audioData = await ttsRequest(text, voiceId);
      fs.writeFileSync(segmentPath, audioData);
      // Respect ElevenLabs rate limits
      if (i < lines.length - 1) await new Promise(r => setTimeout(r, 200));
    }

    segments.push(segmentPath);
    if (onProgress) onProgress(i + 1, lines.length);
  }

  return segments;
}
