package com.rokidai.vats

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.Image
import android.media.ImageReader
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.Toast
import org.tensorflow.lite.DataType
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder

// VATS: камера очков + MoveNet на устройстве. Клик — выстрел, свайп вверх —
// запись видео с точным худом, свайп вниз — диагностика, «назад» — выход.
class VatsActivity : Activity() {

    companion object {
        private const val INPUT_W = 256 // кратно 32 — требование MoveNet
        private const val INPUT_H = 192
        // Запись портретная: контент после поворота сенсора — портрет 3:4.
        private const val REC_W = 480
        private const val REC_H = 640
        private const val FRAME_INTERVAL_MS = 200L
        // При записи каждый кадр видео идёт со СВОИМ распознаванием — худ и
        // картинка строго синхронны, иначе плашки отстают от людей.
        private const val FRAME_INTERVAL_REC_MS = 150L
        private val PART_FACTORS = mapOf(
            "ГОЛОВА" to 0.55f,
            "ТОРС" to 1.0f,
            "РУКИ" to 0.7f,
            "НОГИ" to 0.75f,
        )
        // Сенсор камеры очков смонтирован боком: 270° выяснено на железе 2026-08-22.
        private const val ROTATION = 270
    }

    private val game = VatsGame()
    private lateinit var hud: VatsHudView
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var interpreter: Interpreter? = null
    private var recorder: VatsRecorder? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var lastFrameAt = 0L
    private var startedAt = 0L
    private var frames = 0L
    private var lastInferMs = 0L
    private var debugAutoHidden = false

    // Трекинг целей между кадрами: центр + прогресс захвата.
    private class Track(var cx: Float, var cy: Float, var capture: Float, var vel: Float)
    private var tracks = mutableListOf<Track>()
    @Volatile private var currentTargets: List<VatsDraw.Target> = emptyList()

    private val rgb = IntArray(INPUT_W * INPUT_H)
    private val rgbFull = IntArray(REC_W * REC_H)
    private var recBitmap: Bitmap? = null
    private var debugBmp: Bitmap? = null
    private val output = Array(1) { Array(6) { FloatArray(VatsMath.PERSON_STRIDE) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hud = VatsHudView(this, game)
        setContentView(hud)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
        }
    }

    override fun onResume() {
        super.onResume()
        startedAt = System.currentTimeMillis()
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            start()
        }
    }

    override fun onPause() {
        stopRecording()
        stop()
        super.onPause()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<String>, results: IntArray) {
        if (results.firstOrNull() != PackageManager.PERMISSION_GRANTED) finish()
    }

    private fun start() {
        if (camera != null) return
        thread = HandlerThread("vats").also { it.start() }
        handler = Handler(thread!!.looper)
        interpreter = Interpreter(
            assets.openFd("movenet_multipose.tflite").let { fd ->
                fd.createInputStream().channel.map(
                    java.nio.channels.FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength,
                )
            },
        ).also { it.resizeInput(0, intArrayOf(1, INPUT_H, INPUT_W, 3)) }

        reader = ImageReader.newInstance(640, 480, ImageFormat.YUV_420_888, 2).also { r ->
            r.setOnImageAvailableListener({ onFrame(it) }, handler)
        }
        val manager = getSystemService(CAMERA_SERVICE) as CameraManager
        val id = manager.cameraIdList.firstOrNull() ?: run {
            Toast.makeText(this, "камера не найдена", Toast.LENGTH_LONG).show()
            finish(); return
        }
        try {
            manager.openCamera(
                id,
                object : CameraDevice.StateCallback() {
                    override fun onOpened(device: CameraDevice) {
                        camera = device
                        val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                            .apply { addTarget(reader!!.surface) }
                        device.createCaptureSession(
                            listOf(reader!!.surface),
                            object : CameraCaptureSession.StateCallback() {
                                override fun onConfigured(s: CameraCaptureSession) {
                                    session = s
                                    s.setRepeatingRequest(request.build(), null, handler)
                                }

                                override fun onConfigureFailed(s: CameraCaptureSession) {
                                    toast("камера не настроилась")
                                    finish()
                                }
                            },
                            handler,
                        )
                    }

                    override fun onDisconnected(device: CameraDevice) {
                        toast("камера отключилась")
                        finish()
                    }

                    override fun onError(device: CameraDevice, error: Int) {
                        toast("ошибка камеры: код $error")
                        finish()
                    }
                },
                handler,
            )
        } catch (e: SecurityException) {
            finish()
        }
    }

    // Ресурсы камеры живут на камерном потоке — закрываем их там же, иначе
    // уже поставленный в очередь onFrame гонится с закрытием и роняет приложение.
    private fun stop() {
        val s = session; val c = camera; val r = reader; val i = interpreter; val t = thread
        session = null; camera = null; reader = null; interpreter = null; thread = null
        val h = handler; handler = null
        if (h == null) {
            s?.close(); c?.close(); r?.close(); i?.close(); t?.quitSafely()
            return
        }
        h.post {
            s?.close(); c?.close(); r?.close(); i?.close()
            t?.quitSafely()
        }
    }

    private fun onFrame(r: ImageReader) {
        val image = r.acquireLatestImage() ?: return
        val now = System.currentTimeMillis()
        val interval = if (recorder != null) FRAME_INTERVAL_REC_MS else FRAME_INTERVAL_MS
        if (now - lastFrameAt < interval) {
            image.close(); return
        }
        lastFrameAt = now
        frames++
        try {
            sample(image, rgb, INPUT_W, INPUT_H)
            if (recorder != null) sample(image, rgbFull, REC_W, REC_H)
        } catch (e: Exception) {
            image.close()
            if (recorder != null) failRecording("кадр не прочитался: ${e.message}")
            else hud.debugText = "ошибка кадра: ${e.message}"
            return
        }
        image.close()

        runModel()
        game.tick(now)

        recorder?.let { rec ->
            val bmp = recBitmap ?: Bitmap.createBitmap(REC_W, REC_H, Bitmap.Config.ARGB_8888).also { recBitmap = it }
            bmp.setPixels(rgbFull, 0, REC_W, 0, 0, REC_W, REC_H)
            try {
                rec.frame { canvas ->
                    canvas.drawBitmap(bmp, 0f, 0f, null)
                    // В записи худ рисуется в координатах кадра — совмещение точное.
                    VatsDraw.draw(
                        canvas, REC_W.toFloat(), REC_H.toFloat(), currentTargets, game, now,
                        recording = false, // без красной точки и «СТОП ЗАПИСИ» в самом видео
                        mapX = { nx -> nx * REC_W },
                        mapY = { ny -> ny * REC_H },
                    )
                }
            } catch (e: Exception) {
                failRecording("запись оборвалась: ${e.message}")
            }
        }

        hud.recording = recorder != null
        if (!debugAutoHidden && now - startedAt > 5000) {
            debugAutoHidden = true
            hud.showDebug = false
        }
    }

    private fun runModel() {
        val interp = interpreter ?: return
        try {
            val t0 = System.currentTimeMillis()
            interp.run(fillInput(interp), output)
            lastInferMs = System.currentTimeMillis() - t0
        } catch (e: Exception) {
            runOnUiThread {
                Toast.makeText(this, "модель не запустилась: ${e.message}", Toast.LENGTH_LONG).show()
                finish()
            }
            return
        }
        val flat = FloatArray(6 * VatsMath.PERSON_STRIDE)
        for (p in 0 until 6) output[0][p].copyInto(flat, p * VatsMath.PERSON_STRIDE)
        val people = VatsMath.decode(flat)

        // Сопоставление с прошлыми целями: скорость и прогресс захвата.
        val newTracks = mutableListOf<Track>()
        val targets = people.map { person ->
            val cx = person.box.cx; val cy = person.box.cy
            val old = tracks.minByOrNull { kotlin.math.hypot((it.cx - cx).toDouble(), (it.cy - cy).toDouble()) }
                ?.takeIf { kotlin.math.hypot((it.cx - cx).toDouble(), (it.cy - cy).toDouble()) < 0.15 }
            val vel = if (old != null) kotlin.math.hypot((cx - old.cx).toDouble(), (cy - old.cy).toDouble()).toFloat() else 0f
            val capture = ((old?.capture ?: 0f) + 0.12f).coerceAtMost(1f)
            newTracks += Track(cx, cy, capture, vel)
            tracks.remove(old)
            VatsDraw.Target(
                person = person,
                partPct = PART_FACTORS.mapValues { (_, f) -> VatsMath.hitChance(person.box, vel, f) },
                capture = capture,
                selectedPart = null,
            )
        }
        tracks = newTracks

        // Цель в фокусе — ближайшая к прицелу; в ней выбрана часть, ближайшая к прицелу.
        val focus = targets.minByOrNull { dist2(it.person.box.cx, it.person.box.cy) }
        currentTargets = targets.map { t ->
            if (t !== focus) t
            else VatsDraw.Target(
                t.person, t.partPct, t.capture,
                selectedPart = VatsDraw.PART_ORDER
                    .filter { VatsDraw.partBoxOf(t.person, it) != null }
                    .minByOrNull { name ->
                        val b = VatsDraw.partBoxOf(t.person, name)!!
                        dist2(b.cx, b.cy)
                    },
            )
        }
        hud.targets = currentTargets
        if (hud.showDebug) {
            val bmp = debugBmp ?: Bitmap.createBitmap(INPUT_W, INPUT_H, Bitmap.Config.ARGB_8888).also { debugBmp = it }
            bmp.setPixels(rgb, 0, INPUT_W, 0, 0, INPUT_W, INPUT_H)
            hud.debugBitmap = bmp
            hud.debugText = "кадр $frames · люди ${people.size} · увер. %.2f · %d мс"
                .format(VatsMath.maxRawScore(flat), lastInferMs)
        }
    }

    private fun dist2(x: Float, y: Float): Float {
        val dx = x - 0.5f; val dy = y - 0.5f
        return dx * dx + dy * dy
    }

    // Сэмплирование кадра с поворотом сенсора сразу в целевой размер.
    private fun sample(image: Image, out: IntArray, ow: Int, oh: Int) {
        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val w = image.width
        val h = image.height
        for (oy in 0 until oh) {
            for (ox in 0 until ow) {
                val fx: Float
                val fy: Float
                when (ROTATION) {
                    90 -> { fx = oy / oh.toFloat(); fy = 1f - ox / ow.toFloat() }
                    180 -> { fx = 1f - ox / ow.toFloat(); fy = 1f - oy / oh.toFloat() }
                    270 -> { fx = 1f - oy / oh.toFloat(); fy = ox / ow.toFloat() }
                    else -> { fx = ox / ow.toFloat(); fy = oy / oh.toFloat() }
                }
                val sxx = (fx * (w - 1)).toInt()
                val syy = (fy * (h - 1)).toInt()
                val yv = (yBuf.get(syy * yPlane.rowStride + sxx * yPlane.pixelStride).toInt() and 0xFF)
                val uvRow = (syy / 2) * uPlane.rowStride
                val uvCol = (sxx / 2) * uPlane.pixelStride
                val u = (uBuf.get(uvRow + uvCol).toInt() and 0xFF) - 128
                val v = (vBuf.get(vPlane.rowStride * (syy / 2) + uvCol).toInt() and 0xFF) - 128
                val rr = (yv + 1.370705f * v).toInt().coerceIn(0, 255)
                val gg = (yv - 0.337633f * u - 0.698001f * v).toInt().coerceIn(0, 255)
                val bb = (yv + 1.732446f * u).toInt().coerceIn(0, 255)
                out[oy * ow + ox] = 0xFF000000.toInt() or (rr shl 16) or (gg shl 8) or bb
            }
        }
    }

    // Тип входа зависит от варианта модели — определяем на месте.
    private fun fillInput(interp: Interpreter): ByteBuffer {
        val type = interp.getInputTensor(0).dataType()
        val perChannel = when (type) {
            DataType.UINT8 -> 1
            DataType.FLOAT32, DataType.INT32 -> 4
            else -> error("неожиданный тип входа модели: $type")
        }
        val buf = ByteBuffer.allocateDirect(INPUT_W * INPUT_H * 3 * perChannel)
            .order(ByteOrder.nativeOrder())
        for (px in rgb) {
            val r = (px shr 16) and 0xFF
            val g = (px shr 8) and 0xFF
            val b = px and 0xFF
            when (type) {
                DataType.UINT8 -> { buf.put(r.toByte()); buf.put(g.toByte()); buf.put(b.toByte()) }
                DataType.INT32 -> { buf.putInt(r); buf.putInt(g); buf.putInt(b) }
                else -> { buf.putFloat(r.toFloat()); buf.putFloat(g.toFloat()); buf.putFloat(b.toFloat()) }
            }
        }
        buf.rewind()
        return buf
    }

    // Игра и рекордер живут на камерном потоке; из UI-обработчиков клавиш
    // к ним ходим только через post — иначе гонка со стоп/кадром.
    private fun shoot() {
        handler?.post {
            val focus = currentTargets.firstOrNull { it.selectedPart != null } ?: return@post
            val pct = focus.partPct[focus.selectedPart] ?: return@post
            game.shoot(System.currentTimeMillis(), pct)
        }
    }

    private fun toggleRecording() {
        handler?.post {
            if (recorder != null) {
                finishRecording()
            } else {
                try {
                    recorder = VatsRecorder(this, REC_W, REC_H).also { it.start() }
                } catch (e: Exception) {
                    recorder = null
                    toast("запись не запустилась: ${e.message}")
                }
            }
            hud.recording = recorder != null
        }
    }

    // Только с камерного потока.
    private fun finishRecording() {
        val rec = recorder ?: return
        recorder = null
        val ok = try { rec.stop() } catch (e: Exception) { false }
        toast(if (ok) "запись сохранена в Movies/VATS" else "запись не удалась, файл удалён")
        hud.recording = false
    }

    // Только с камерного потока: авария по ходу записи.
    private fun failRecording(reason: String) {
        val rec = recorder ?: return
        recorder = null
        try { rec.stop() } catch (_: Exception) {}
        toast(reason)
        hud.recording = false
    }

    private fun stopRecording() {
        handler?.post { finishRecording() }
    }

    private fun toast(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> { shoot(); return true }
            KeyEvent.KEYCODE_DPAD_UP -> { toggleRecording(); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { hud.showDebug = !hud.showDebug; return true }
            KeyEvent.KEYCODE_BACK -> { stopRecording(); finish(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }
}
