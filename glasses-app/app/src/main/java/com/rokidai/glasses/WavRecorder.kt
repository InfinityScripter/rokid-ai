package com.rokidai.glasses

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import kotlin.math.sqrt

// Запись с микрофона очков: PCM 16 кГц моно 16 бит, на stop() приклеивается
// WAV-заголовок. Автостоп: пороги речи/тишины считаются от плавающего пола
// фонового шума (на улице шумно, в комнате тихо — жёсткий порог не работает
// ни там, ни там). Пол мгновенно падает до самого тихого кадра и медленно
// ползёт вверх, поэтому речь прямо со старта записи его не отравляет: первая
// же пауза между словами возвращает пол к реальному фону. Гистерезис: речь
// фиксируется по верхнему порогу, а «ещё не тишина» — по нижнему, чтобы
// тихий хвост фразы не запускал таймер сброса. onAutoStop и onLevel
// дёргаются из фонового потока.
class WavRecorder {
    private companion object {
        const val SAMPLE_RATE = 16000
        const val MIN_SPEECH_BYTES = 12800
        const val NOISE_FLOOR_RISE = 1.005
        const val MIN_SPEECH_RMS = 500.0
        const val MIN_SILENCE_RMS = 300.0
        const val SILENCE_MS = 2200L
        const val NO_SPEECH_MS = 8_000L
        const val MAX_RECORD_MS = 60_000L
    }

    private var audioRecord: AudioRecord? = null
    private var thread: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var speechDetected = false

    @SuppressLint("MissingPermission")
    fun start(onLevel: (Double) -> Unit, onAutoStop: () -> Unit) {
        pcm.reset()
        speechDetected = false
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        )
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuffer * 4,
        )
        audioRecord = record
        record.startRecording()
        thread = Thread {
            val buffer = ByteArray(minBuffer)
            val startedAt = System.currentTimeMillis()
            var noiseFloor = -1.0
            var lastLoudAt = System.currentTimeMillis()
            var autoStopFired = false
            while (audioRecord === record) {
                val read = record.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                synchronized(pcm) { pcm.write(buffer, 0, read) }
                val rms = rms(buffer, read)
                onLevel(rms)
                val now = System.currentTimeMillis()
                noiseFloor = if (noiseFloor < 0) rms else minOf(rms, noiseFloor * NOISE_FLOOR_RISE)
                val speechThreshold = maxOf(noiseFloor * 3.0, MIN_SPEECH_RMS)
                val silenceThreshold = maxOf(noiseFloor * 1.8, MIN_SILENCE_RMS)
                if (rms >= speechThreshold) {
                    speechDetected = true
                    lastLoudAt = now
                } else if (speechDetected && rms >= silenceThreshold) {
                    lastLoudAt = now
                }
                val silentTooLong = speechDetected && now - lastLoudAt >= SILENCE_MS
                val noSpeechTooLong = !speechDetected && now - startedAt >= NO_SPEECH_MS
                val recordTooLong = now - startedAt >= MAX_RECORD_MS
                if (!autoStopFired && (silentTooLong || noSpeechTooLong || recordTooLong)) {
                    autoStopFired = true
                    onAutoStop()
                }
            }
        }.also { it.start() }
    }

    private fun rms(buffer: ByteArray, length: Int): Double {
        var sum = 0.0
        var i = 0
        while (i + 1 < length) {
            val sample = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xff)).toShort()
            sum += sample.toDouble() * sample
            i += 2
        }
        return sqrt(sum / (length / 2))
    }

    /** null — если запись слишком короткая (случайный клик) или речи в ней не было. */
    fun stop(): ByteArray? {
        val record = audioRecord ?: return null
        audioRecord = null
        thread?.join(500)
        thread = null
        record.stop()
        record.release()
        val data = synchronized(pcm) { pcm.toByteArray() }
        if (!speechDetected || data.size < MIN_SPEECH_BYTES) return null
        return wrapWav(data)
    }

    private fun wrapWav(pcmData: ByteArray): ByteArray {
        val byteRate = SAMPLE_RATE * 2
        val totalLen = 36 + pcmData.size
        val header = ByteArray(44)
        fun putLE(offset: Int, value: Int, bytes: Int) {
            for (i in 0 until bytes) header[offset + i] = ((value shr (8 * i)) and 0xff).toByte()
        }
        "RIFF".toByteArray().copyInto(header, 0)
        putLE(4, totalLen, 4)
        "WAVE".toByteArray().copyInto(header, 8)
        "fmt ".toByteArray().copyInto(header, 12)
        putLE(16, 16, 4); putLE(20, 1, 2); putLE(22, 1, 2)
        putLE(24, SAMPLE_RATE, 4); putLE(28, byteRate, 4)
        putLE(32, 2, 2); putLE(34, 16, 2)
        "data".toByteArray().copyInto(header, 36)
        putLE(40, pcmData.size, 4)
        return header + pcmData
    }
}
