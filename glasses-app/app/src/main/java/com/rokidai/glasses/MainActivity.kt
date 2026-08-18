package com.rokidai.glasses

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {

    private enum class State { IDLE, LISTENING, SENDING }

    private companion object {
        const val BRIGHT = 0xFF45F068.toInt()
        const val DIM = 0xFF2E9E46.toInt()
        const val DIVIDER = 0xFF1C5A2C.toInt()
        const val PANEL_HEIGHT = 320
        const val TYPE_INTERVAL_MS = 24L
    }

    private var state = State.IDLE
    private val recorder = WavRecorder()
    private val scope = CoroutineScope(Dispatchers.Main)
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var queue: QueueStore
    private lateinit var dotView: View
    private lateinit var stateNameView: TextView
    private lateinit var queueBadgeView: TextView
    private lateinit var linkView: TextView
    private lateinit var historyList: LinearLayout
    private lateinit var historyScroll: ScrollView

    private var pulse: ObjectAnimator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    @Volatile private var draining = false

    // Строка истории: иконка судьбы + основной текст + подстрока.
    private inner class HistoryRow(icon: Int, main: String, sub: String, dim: Boolean) {
        val iconView = ImageView(this@MainActivity).apply {
            setImageResource(icon)
            layoutParams = LinearLayout.LayoutParams(28, 28).apply { topMargin = 4; rightMargin = 8 }
        }
        val mainView = TextView(this@MainActivity).apply {
            textSize = 12f
            setTextColor(if (dim) DIM else BRIGHT)
            maxLines = 2
            text = main
        }
        val subView = TextView(this@MainActivity).apply {
            textSize = 10f
            setTextColor(DIM)
            maxLines = 2
            text = sub
            visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE
        }
        val root = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 8, 0, 0)
            addView(iconView)
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(mainView)
                addView(subView)
            })
        }

        fun setIcon(res: Int) = iconView.setImageResource(res)
        fun setMain(text: String, bright: Boolean = true) {
            mainView.setTextColor(if (bright) BRIGHT else DIM)
            mainView.text = text
        }
        fun setSub(text: String) {
            subView.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
            subView.text = text
        }
        fun typeSub(full: String) {
            subView.visibility = View.VISIBLE
            var i = 0
            fun step() {
                if (i <= full.length) {
                    subView.text = full.substring(0, i)
                    i += 2
                    ui.postDelayed(::step, TYPE_INTERVAL_MS)
                }
            }
            step()
        }
    }

    private val rowsByRecordingId = mutableMapOf<String, HistoryRow>()

    private fun api(): ApiClient? {
        val prefs = getSharedPreferences("config", MODE_PRIVATE)
        val url = prefs.getString("url", null) ?: BuildConfig.DEFAULT_URL.ifEmpty { null } ?: return null
        val token = prefs.getString("token", null) ?: BuildConfig.DEFAULT_TOKEN.ifEmpty { null } ?: return null
        return ApiClient(url, token)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        queue = QueueStore(File(filesDir, "pending"))

        // Контент — только в верхней половине дисплея 480×640 (безопасная зона).
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 88, 24, 0)
        }

        // Шапка: пульс-точка + имя состояния | счётчик очереди + связь.
        dotView = View(this).apply {
            setBackgroundColor(BRIGHT)
            layoutParams = LinearLayout.LayoutParams(14, 14).apply { rightMargin = 10 }
        }
        stateNameView = TextView(this).apply {
            textSize = 13f
            typeface = Typeface.MONOSPACE
            letterSpacing = 0.18f
            setTextColor(BRIGHT)
            text = "ГОТОВ"
        }
        queueBadgeView = TextView(this).apply {
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(DIM)
        }
        linkView = TextView(this).apply {
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextColor(BRIGHT)
            text = "●"
            setPadding(12, 0, 0, 0)
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(dotView)
            addView(stateNameView)
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(queueBadgeView)
            addView(linkView)
        }
        val divider = View(this).apply {
            setBackgroundColor(DIVIDER)
            layoutParams = LinearLayout.LayoutParams(-1, 2).apply { topMargin = 8; bottomMargin = 4 }
        }
        historyList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        historyScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(historyList)
        }

        panel.addView(header)
        panel.addView(divider)
        panel.addView(historyScroll, LinearLayout.LayoutParams(-1, -1))
        root.addView(panel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, PANEL_HEIGHT))
        setContentView(root)

        ensureWifi()
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
        }

        // Ждущие сеть заметки прошлых запусков — сразу в ленту.
        for (file in queue.pending()) {
            rowsByRecordingId[file.name] = addRow(R.drawable.ic_clock, noteTitle(file.name), "дошлю при сети", dim = false)
        }
        setHeader(if (api() == null) "НЕТ НАСТРОЕК" else "ГОТОВ")
        refreshQueueBadge()
        scheduleDrain(3_000)
        schedulePing()
    }

    private fun noteTitle(recordingId: String): String {
        val ts = recordingId.removeSuffix(".wav").toLongOrNull() ?: return "Заметка"
        return "Заметка " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
    }

    private fun addRow(icon: Int, main: String, sub: String, dim: Boolean): HistoryRow {
        val row = HistoryRow(icon, main, sub, dim)
        historyList.addView(row.root, 0)
        while (historyList.childCount > 12) historyList.removeViewAt(historyList.childCount - 1)
        historyScroll.post { historyScroll.smoothScrollTo(0, 0) }
        return row
    }

    private fun setHeader(name: String) {
        stateNameView.text = name
        pulse?.cancel()
        dotView.alpha = 1f
        when (state) {
            State.LISTENING -> pulse = ObjectAnimator.ofFloat(dotView, "alpha", 1f, 0.2f).apply {
                duration = 420; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
            }
            State.SENDING -> pulse = ObjectAnimator.ofFloat(dotView, "alpha", 1f, 0.5f).apply {
                duration = 900; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE; start()
            }
            State.IDLE -> {}
        }
    }

    private fun refreshQueueBadge() {
        val count = queue.pending().size
        queueBadgeView.text = if (count > 0) "⧗$count" else ""
    }

    private fun setLinkUp(up: Boolean) {
        linkView.text = if (up) "●" else "○"
        linkView.setTextColor(if (up) BRIGHT else DIM)
    }

    @Suppress("DEPRECATION")
    private fun ensureWifi() {
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        if (!wifi.isWifiEnabled) runCatching { wifi.isWifiEnabled = true }
    }

    private fun acquireLocks() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rokidai:turn").also { it.acquire(90_000) }
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "rokidai:turn").also { it.acquire() }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.release() }
        runCatching { wifiLock?.release() }
        wakeLock = null
        wifiLock = null
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> {
                when (state) {
                    State.IDLE -> startListening()
                    State.LISTENING -> finishListening()
                    State.SENDING -> {}
                }
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (state == State.LISTENING) {
                    recorder.stop()
                    state = State.IDLE
                    setHeader("ГОТОВ")
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun startListening() {
        ensureWifi()
        state = State.LISTENING
        setHeader("ЗАПИСЬ")
        recorder.start { ui.post { if (state == State.LISTENING) finishListening() } }
    }

    private fun finishListening() {
        val wav = recorder.stop()
        state = State.IDLE
        setHeader("ГОТОВ")
        if (wav == null) return
        val file = queue.add(wav)
        rowsByRecordingId[file.name] = addRow(R.drawable.ic_mic, noteTitle(file.name), "", dim = false)
        refreshQueueBadge()
        drainQueue()
    }

    private fun scheduleDrain(delayMs: Long) {
        ui.postDelayed({
            if (queue.pending().isNotEmpty()) drainQueue()
            scheduleDrain(45_000)
        }, delayMs)
    }

    private fun schedulePing() {
        ui.postDelayed({
            val client = api()
            if (client != null && !draining) {
                scope.launch(Dispatchers.IO) {
                    val up = client.ping()
                    scope.launch { setLinkUp(up) }
                }
            }
            schedulePing()
        }, 20_000)
    }

    private fun drainQueue() {
        if (draining) return
        val client = api() ?: run { setHeader("НЕТ НАСТРОЕК"); return }
        draining = true
        state = State.SENDING
        setHeader("ОТПРАВКА")
        acquireLocks()
        scope.launch(Dispatchers.IO) {
            try {
                for (file in queue.pending()) {
                    val row = rowsByRecordingId[file.name]
                    try {
                        client.chat(file.readBytes(), recordingId = file.name) { type, text ->
                            scope.launch {
                                when (type) {
                                    "user" -> row?.setMain(text)
                                    "answer" -> {
                                        row?.setIcon(R.drawable.ic_check)
                                        row?.typeSub(text.lineSequence().firstOrNull() ?: text)
                                    }
                                    "error" -> {
                                        row?.setIcon(R.drawable.ic_warn)
                                        row?.setSub(text)
                                    }
                                }
                            }
                        }
                        queue.remove(file)
                        scope.launch { setLinkUp(true); refreshQueueBadge() }
                    } catch (e: java.io.IOException) {
                        scope.launch {
                            setLinkUp(false)
                            row?.setIcon(R.drawable.ic_clock)
                            row?.setSub("дошлю при сети")
                        }
                        break
                    }
                }
            } finally {
                scope.launch {
                    releaseLocks()
                    draining = false
                    state = State.IDLE
                    setHeader("ГОТОВ")
                    refreshQueueBadge()
                }
            }
        }
    }
}
