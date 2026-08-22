package com.rokidai.glasses

import android.animation.ValueAnimator
import android.view.animation.LinearInterpolator
import android.app.Activity
import android.content.Intent
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
import kotlin.math.sin

class MainActivity : Activity() {

    companion object {
        // Чем нас открыли — показываем в ленте, чтобы было видно,
        // какая кнопка сработала на самом деле.
        const val EXTRA_TRIGGER = "trigger"

        private const val BRIGHT = 0xFF45F068.toInt()
        private const val DIM = 0xFF2E9E46.toInt()
        private const val DIVIDER = 0xFF1C5A2C.toInt()
        private const val PANEL_HEIGHT = 320
        private const val TYPE_INTERVAL_MS = 24L
        private const val WAVE_BARS = 5
        private const val WAVE_BAR_MIN = 4
        private const val WAVE_BAR_MAX = 22
        private const val WAVE_FULL_RMS = 3500f
        private const val DOUBLE_CLICK_MS = 350L
    }

    // Запись и отправка независимы: можно диктовать новую заметку, пока
    // предыдущие уходят на сервер в фоне.
    private var listening = false
    private var recordStartedAt = 0L
    private var pendingFinish: Runnable? = null
    private val recorder = WavRecorder()
    private val scope = CoroutineScope(Dispatchers.Main)
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var queue: QueueStore
    private lateinit var waveBars: List<View>
    private lateinit var stateNameView: TextView
    private lateinit var hintView: TextView
    private lateinit var queueBadgeView: TextView
    private lateinit var linkView: TextView
    private lateinit var historyList: LinearLayout
    private lateinit var historyScroll: ScrollView

    private var waveAnimator: ValueAnimator? = null
    private val waveLevels = FloatArray(WAVE_BARS)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    @Volatile private var draining = false

    // Масштаб текста из «Пробы зрения»: если мелкое на очках двоится,
    // подрастает весь интерфейс, а не одна надпись.
    private var textScale = 1f
    private var textBold = false

    // Строка истории: иконка судьбы + основной текст + подстрока.
    private inner class HistoryRow(icon: Int, main: String, sub: String, dim: Boolean) {
        val iconView = ImageView(this@MainActivity).apply {
            setImageResource(icon)
            layoutParams = LinearLayout.LayoutParams(28, 28).apply { topMargin = 4; rightMargin = 8 }
        }
        val mainView = TextView(this@MainActivity).apply {
            textSize = 12f * textScale
            typeface = if (textBold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            setTextColor(if (dim) DIM else BRIGHT)
            maxLines = 2
            text = main
        }
        val subView = TextView(this@MainActivity).apply {
            textSize = 10f * textScale
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

        fun applyScale() {
            mainView.textSize = 12f * textScale
            mainView.typeface = if (textBold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            subView.textSize = 10f * textScale
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
    private val rows = mutableListOf<HistoryRow>()

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

        // Шапка: волна-эквалайзер + имя состояния | счётчик очереди + связь.
        // При записи столбики прыгают от живой громкости микрофона, при
        // отправке — бегущая синусоида, в покое — низкие и неподвижные.
        waveBars = List(WAVE_BARS) {
            View(this).apply {
                setBackgroundColor(BRIGHT)
                layoutParams = LinearLayout.LayoutParams(5, WAVE_BAR_MIN).apply { rightMargin = 3 }
            }
        }
        val waveView = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, WAVE_BAR_MAX,
            ).apply { rightMargin = 8 }
            waveBars.forEach(::addView)
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
            addView(waveView)
            addView(stateNameView)
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(queueBadgeView)
            addView(linkView)
        }
        val divider = View(this).apply {
            setBackgroundColor(DIVIDER)
            layoutParams = LinearLayout.LayoutParams(-1, 2).apply { topMargin = 8; bottomMargin = 4 }
        }
        // Шпаргалка: что делает кнопка дужки прямо сейчас.
        hintView = TextView(this).apply {
            textSize = 10f
            setTextColor(DIM)
        }
        historyList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        historyScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = false
            addView(historyList)
        }

        panel.addView(header)
        panel.addView(divider)
        panel.addView(hintView)
        panel.addView(historyScroll, LinearLayout.LayoutParams(-1, -1))
        root.addView(panel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, PANEL_HEIGHT))
        setContentView(root)

        ensureWifi()
        if (!hasMicPermission()) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 1)
        }

        // Ждущие сеть заметки прошлых запусков — сразу в ленту.
        for (file in queue.pending()) {
            rowsByRecordingId[file.name] = addRow(R.drawable.ic_clock, noteTitle(file.name), "дошлю при сети", dim = false)
        }
        updateHeader()
        refreshQueueBadge()
        scheduleDrain(3_000)
        schedulePing()
        loadVisionProfile()
        // Служба «наготове» живёт независимо от экрана: закрыл заметку —
        // кнопка дужки всё равно откроет её снова.
        startForegroundService(Intent(this, ListenerService::class.java))
    }

    private fun noteTitle(recordingId: String): String {
        val ts = recordingId.removeSuffix(".wav").toLongOrNull() ?: return "Заметка"
        return "Заметка " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
    }

    private fun addRow(icon: Int, main: String, sub: String, dim: Boolean): HistoryRow {
        val row = HistoryRow(icon, main, sub, dim)
        historyList.addView(row.root, 0)
        rows.add(0, row)
        while (historyList.childCount > 12) {
            historyList.removeViewAt(historyList.childCount - 1)
            rows.removeAt(rows.size - 1)
        }
        historyScroll.post { historyScroll.smoothScrollTo(0, 0) }
        return row
    }

    private fun setBarLevel(bar: View, level: Float) {
        val lp = bar.layoutParams
        lp.height = WAVE_BAR_MIN + ((WAVE_BAR_MAX - WAVE_BAR_MIN) * level.coerceIn(0f, 1f)).toInt()
        bar.layoutParams = lp
    }

    // Живая громкость с микрофона: лента уровней ползёт справа налево.
    private fun pushWaveLevel(rms: Double) {
        if (!listening) return
        for (i in 0 until WAVE_BARS - 1) waveLevels[i] = waveLevels[i + 1]
        waveLevels[WAVE_BARS - 1] = (rms.toFloat() / WAVE_FULL_RMS).coerceIn(0.08f, 1f)
        waveBars.forEachIndexed { i, bar -> setBarLevel(bar, waveLevels[i]) }
    }

    private fun recordClock(): String {
        val sec = ((System.currentTimeMillis() - recordStartedAt) / 1000).toInt()
        return "ЗАПИСЬ %d:%02d".format(Locale.US, sec / 60, sec % 60)
    }

    // Один Runnable на всё приложение: перед каждым стартом записи старый
    // снимается, иначе цепочки тиков множатся с каждым рестартом.
    private val recordTimerTick = object : Runnable {
        override fun run() {
            if (!listening) return
            stateNameView.text = recordClock()
            ui.postDelayed(this, 1_000)
        }
    }

    // Шапка целиком выводится из пары (запись, отправка): запись главнее.
    private fun updateHeader() {
        waveAnimator?.cancel()
        waveAnimator = null
        when {
            listening -> {
                stateNameView.text = recordClock()
                hintView.text = "клик — отправить · клик-клик — отмена"
                waveLevels.fill(0.08f)
                waveBars.forEach { setBarLevel(it, 0.08f) }
            }
            draining -> {
                stateNameView.text = "ОТПРАВКА"
                hintView.text = "клик — новая заметка"
                waveAnimator = ValueAnimator.ofFloat(0f, (2 * Math.PI).toFloat()).apply {
                    duration = 1200
                    repeatCount = ValueAnimator.INFINITE
                    interpolator = LinearInterpolator()
                    addUpdateListener { anim ->
                        val phase = anim.animatedValue as Float
                        waveBars.forEachIndexed { i, bar ->
                            setBarLevel(bar, 0.2f + 0.4f * (sin(phase + i * 0.9f) + 1f) / 2f)
                        }
                    }
                    start()
                }
            }
            else -> {
                val configured = api() != null
                stateNameView.text = if (configured) "ГОТОВ" else "НЕТ НАСТРОЕК"
                hintView.text = if (configured) "клик — новая заметка" else "передай адрес и токен через adb broadcast"
                waveBars.forEach { setBarLevel(it, 0f) }
            }
        }
    }

    // Профиль подбирает «Проба зрения», хранится он на сервере — поэтому
    // подобранный однажды размер работает и здесь, и в агенте-табло.
    // Шаг вспомогательный: не ответил сервер — приложение работает как прежде.
    private fun loadVisionProfile() {
        val client = api() ?: return
        scope.launch(Dispatchers.IO) {
            val profile = client.visionProfile() ?: return@launch
            scope.launch { applyVisionProfile(profile.first, profile.second) }
        }
    }

    private fun applyVisionProfile(size: Int, bold: Boolean) {
        // Считаем от самой мелкой ступени пробы (14) и не растём больше чем
        // вдвое: иначе на 480×640 не остаётся места под саму ленту заметок.
        textScale = (size / 14f).coerceIn(1f, 2f)
        textBold = bold
        stateNameView.textSize = 13f * textScale
        hintView.textSize = 10f * textScale
        queueBadgeView.textSize = 11f * textScale
        linkView.textSize = 12f * textScale
        rows.forEach { it.applyScale() }
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

    // Запись стартует сама: приложение открывают ради заметки.
    override fun onResume() {
        super.onResume()
        intent?.getStringExtra(EXTRA_TRIGGER)?.let { trigger ->
            intent.removeExtra(EXTRA_TRIGGER)
            addRow(R.drawable.ic_clock, "Открыто: $trigger", "", dim = true)
        }
        if (!listening && hasMicPermission()) startListening()
    }

    // Приложение уже открыто, кнопка нажата снова — новая заметка.
    override fun onNewIntent(newIntent: Intent?) {
        super.onNewIntent(newIntent)
        newIntent?.let { setIntent(it) }
    }

    private fun hasMicPermission() =
        checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    // Одна кнопка: клик в покое — запись; клик в записи — отправить (с паузой
    // DOUBLE_CLICK_MS на случай второго клика); двойной клик — отменить запись.
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER -> {
                when {
                    !listening -> startListening()
                    pendingFinish != null -> cancelListening()
                    else -> {
                        val finish = Runnable {
                            pendingFinish = null
                            if (listening) finishListening()
                        }
                        pendingFinish = finish
                        ui.postDelayed(finish, DOUBLE_CLICK_MS)
                    }
                }
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (listening) {
                    cancelListening()
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun startListening() {
        if (!hasMicPermission()) return
        ensureWifi()
        listening = true
        recordStartedAt = System.currentTimeMillis()
        updateHeader()
        ui.removeCallbacks(recordTimerTick)
        ui.postDelayed(recordTimerTick, 1_000)
        recorder.start(
            onLevel = { rms -> ui.post { pushWaveLevel(rms) } },
            onAutoStop = { ui.post { if (listening && pendingFinish == null) finishListening() } },
        )
    }

    // Отложенный «финиш» обязан сниматься при любом завершении записи,
    // иначе он добьёт следующую запись, начатую в его 350-мс окне.
    private fun clearPendingFinish() {
        pendingFinish?.let(ui::removeCallbacks)
        pendingFinish = null
    }

    private fun cancelListening() {
        clearPendingFinish()
        recorder.stop()
        listening = false
        updateHeader()
        addRow(R.drawable.ic_warn, "Заметка отменена", "", dim = true)
    }

    private fun finishListening() {
        clearPendingFinish()
        val wav = recorder.stop()
        listening = false
        updateHeader()
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
        val client = api() ?: run { updateHeader(); return }
        draining = true
        updateHeader()
        acquireLocks()
        scope.launch(Dispatchers.IO) {
            try {
                // Внешний цикл берёт свежий снимок очереди: заметка,
                // надиктованная во время отправки, уходит этим же заходом.
                drain@ while (true) {
                    val files = queue.pending()
                    if (files.isEmpty()) break
                    for (file in files) {
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
                            // Не удалился — иначе цикл будет слать его вечно.
                            if (!queue.remove(file)) break@drain
                            scope.launch { setLinkUp(true); refreshQueueBadge() }
                        } catch (e: java.io.IOException) {
                            scope.launch {
                                setLinkUp(false)
                                row?.setIcon(R.drawable.ic_clock)
                                row?.setSub("дошлю при сети")
                            }
                            break@drain
                        } catch (e: Exception) {
                            // Кривой ответ сервера (не сеть): файл убираем, чтобы
                            // не долбить им сервер вечно; корутину не роняем —
                            // упавший scope молча остановил бы весь интерфейс.
                            queue.remove(file)
                            scope.launch {
                                row?.setIcon(R.drawable.ic_warn)
                                row?.setSub(e.message ?: "ошибка ответа")
                                refreshQueueBadge()
                            }
                        }
                    }
                }
            } finally {
                scope.launch {
                    releaseLocks()
                    draining = false
                    updateHeader()
                    refreshQueueBadge()
                    // Заметка могла добавиться между последним снимком очереди
                    // и выходом из цикла — дострелить сразу, не ждать 45 секунд.
                    if (queue.pending().isNotEmpty()) drainQueue()
                }
            }
        }
    }
}
