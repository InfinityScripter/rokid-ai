package com.rokidai.vats

import android.content.ContentValues
import android.content.Context
import android.graphics.Canvas
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.view.Surface

// Запись MP4: кадр камеры + худ рисуются на поверхность кодировщика H.264,
// файл уходит в галерею (Movies/VATS) через MediaStore. Все методы зовутся
// с одного потока (камерный HandlerThread) — внутренней синхронизации нет.
class VatsRecorder(private val context: Context, private val width: Int, private val height: Int) {

    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var surface: Surface? = null
    private var pfd: ParcelFileDescriptor? = null
    private var uri: Uri? = null
    private var track = -1
    private var started = false
    private val bufferInfo = MediaCodec.BufferInfo()

    val running get() = codec != null

    fun start() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 10)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            surface = c.createInputSurface()
            c.start()

            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, "vats-${System.currentTimeMillis()}.mp4")
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/VATS")
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val u = resolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
                ?: error("MediaStore не дал создать файл")
            uri = u
            pfd = resolver.openFileDescriptor(u, "w") ?: error("файл не открылся на запись")
            muxer = MediaMuxer(pfd!!.fileDescriptor, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            codec = c
        } catch (e: Throwable) {
            // Полуинициализированный кодек нельзя терять — иначе кончатся
            // аппаратные инстансы кодировщика.
            surface?.release(); surface = null
            try { c.release() } catch (_: Exception) {}
            uri?.let { context.contentResolver.delete(it, null, null) }
            uri = null
            pfd?.close(); pfd = null
            throw e
        }
    }

    // Кадр рисуется вызывающей стороной на канве поверхности кодировщика.
    fun frame(draw: (Canvas) -> Unit) {
        val s = surface ?: return
        val canvas = s.lockHardwareCanvas()
        try {
            draw(canvas)
        } finally {
            s.unlockCanvasAndPost(canvas)
        }
        drain(endOfStream = false)
    }

    private fun drain(endOfStream: Boolean) {
        val c = codec ?: return
        val m = muxer ?: return
        if (endOfStream) c.signalEndOfInputStream()
        // Дедлайн: некоторые аппаратные кодеки не присылают маркер конца потока,
        // без него цикл ожидания стал бы вечным.
        val deadline = System.currentTimeMillis() + 2000
        while (true) {
            if (endOfStream && System.currentTimeMillis() > deadline) return
            val idx = c.dequeueOutputBuffer(bufferInfo, if (endOfStream) 10_000L else 0L)
            when {
                idx == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track = m.addTrack(c.outputFormat)
                    m.start()
                    started = true
                }
                idx >= 0 -> {
                    val buf = c.getOutputBuffer(idx) ?: continue
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 &&
                        bufferInfo.size > 0 && started
                    ) {
                        m.writeSampleData(track, buf, bufferInfo)
                    }
                    c.releaseOutputBuffer(idx, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }

    // true — файл корректно финализирован и опубликован в галерею;
    // false — запись битая, файл удалён, показывать «сохранено» нельзя.
    fun stop(): Boolean {
        var ok = true
        try { drain(endOfStream = true) } catch (_: Exception) { ok = false }
        try { codec?.stop() } catch (_: Exception) { ok = false }
        try { codec?.release() } catch (_: Exception) {}
        codec = null
        surface?.release(); surface = null
        if (started) {
            try { muxer?.stop() } catch (_: Exception) { ok = false }
        } else {
            ok = false // ни одного кадра не дошло до файла
        }
        try { muxer?.release() } catch (_: Exception) {}
        muxer = null; started = false; track = -1
        try { pfd?.close() } catch (_: Exception) { ok = false }
        pfd = null
        uri?.let { u ->
            val resolver = context.contentResolver
            if (ok) {
                resolver.update(u, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
            } else {
                try { resolver.delete(u, null, null) } catch (_: Exception) {}
            }
        }
        uri = null
        return ok
    }
}
