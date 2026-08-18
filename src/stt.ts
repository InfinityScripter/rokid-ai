import { execFile } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import OpenAI from 'openai';

import { config } from './config.js';

const run = promisify(execFile);

// Два провайдера распознавания:
// - whisper-cpp: локально, бесплатно, аудио не покидает машину (Мак);
// - openrouter: Gemini с аудио-входом через уже имеющийся ключ (VDS —
//   там 1 ядро и 1 ГБ памяти, локальный Whisper не помещается).
export async function transcribe(audioPath: string): Promise<string> {
  return config.STT_PROVIDER === 'openrouter' ? transcribeViaOpenRouter(audioPath) : transcribeViaWhisperCpp(audioPath);
}

async function transcribeViaWhisperCpp(audioPath: string): Promise<string> {
  try {
    await access(config.WHISPER_MODEL_PATH);
  } catch {
    throw new Error(
      `Модель Whisper не найдена: ${config.WHISPER_MODEL_PATH}. ` +
        'Установи whisper.cpp (brew install whisper-cpp) и скачай модель — см. README.',
    );
  }

  const wavPath = `${audioPath}.wav`;
  await run('ffmpeg', ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath]);
  try {
    const outBase = `${wavPath}.out`;
    await run('whisper-cli', [
      '-m', config.WHISPER_MODEL_PATH,
      '-l', 'ru',
      '-f', wavPath,
      '--output-txt',
      '--output-file', outBase,
      '--no-prints',
    ]);
    const text = await readFile(`${outBase}.txt`, 'utf8');
    await rm(`${outBase}.txt`, { force: true });
    return text.trim();
  } finally {
    await rm(wavPath, { force: true });
  }
}

const sttClient = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: config.OPENROUTER_API_KEY,
});

async function transcribeViaOpenRouter(audioPath: string): Promise<string> {
  const mp3Path = `${audioPath}.mp3`;
  await run('ffmpeg', ['-y', '-i', audioPath, '-ac', '1', '-b:a', '48k', mp3Path]);
  try {
    const audioBase64 = (await readFile(mp3Path)).toString('base64');
    const response = await sttClient.chat.completions.create({
      model: config.STT_MODEL,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: audioBase64, format: 'mp3' } },
            {
              type: 'text',
              text: 'Расшифруй аудио дословно (язык — русский, возможны английские термины). Верни только текст расшифровки, без комментариев и кавычек.',
            },
          ],
        },
      ],
    });
    return (response.choices[0]?.message.content ?? '').trim();
  } finally {
    await rm(mp3Path, { force: true });
  }
}

export function tmpAudioPath(fileId: string, remotePath: string): string {
  return path.join('/tmp', `rokid-ai-${fileId}${path.extname(remotePath) || '.oga'}`);
}
